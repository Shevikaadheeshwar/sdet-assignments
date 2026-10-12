import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * One subscription's whole life (strategy §12, P2-15).
 *
 * The other suites isolate a single behaviour each. This one follows a single
 * subscription from creation to cancellation and checks the API response, the
 * persisted rows, the provider call log and the invariants at *every* hop —
 * because the bugs that survive focused tests are usually the ones that need
 * two steps to appear.
 */
describe('end to end: trial -> active -> past_due -> active -> canceled', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  it('keeps the API, the database and the provider in agreement throughout', async () => {
    // ---- 1. Created on a plan with a trial -------------------------------
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
    );
    const id = created.body.id;

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('trialing');
    expect(created.body.trial_days).toBe(14);
    expect(harness.provider.chargeCount).toBe(0);
    expect(harness.db.invoicesFor(id)).toHaveLength(0);
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 2. Trial ends, first charge succeeds ----------------------------
    harness.provider.willSucceed('ref_period_1');
    const activated = await harness.api.billSubscription(id);

    expect(activated.body.status).toBe('active');
    expect(harness.provider.chargeCount).toBe(1);
    expect(harness.provider.charges[0]).toMatchObject({ amountMinor: 1900, customerId: 'cust_001' });
    expect(harness.db.invoicesFor(id)).toHaveLength(1);
    expect(harness.db.invoicesFor(id)[0]?.status).toBe('paid');
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 3. The next period's charge fails -------------------------------
    harness.provider.willDecline('insufficient_funds');
    const pastDue = await harness.api.billSubscription(id);

    expect(pastDue.body.status).toBe('past_due');
    expect(harness.provider.chargeCount).toBe(2);
    expect(harness.db.invoicesFor(id)).toHaveLength(2);
    expect(harness.db.invoicesFor(id)[1]?.status).toBe('failed');
    expect(harness.db.subscription(id)?.failed_attempts).toBe(1);
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 4. A retry settles the same unpaid invoice ----------------------
    harness.provider.willSucceed('ref_period_2_retry');
    const recovered = await harness.api.billSubscription(id);

    expect(recovered.body.status).toBe('active');
    expect(harness.provider.chargeCount).toBe(3);
    // Still two invoices: the retry settled period 2, it did not open period 3.
    expect(harness.db.invoicesFor(id)).toHaveLength(2);
    expect(harness.db.invoicesFor(id)[1]?.status).toBe('paid');
    expect(harness.db.subscription(id)?.failed_attempts).toBe(0);
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 5. A stale failure for the settled invoice arrives late ---------
    const settledInvoiceId = harness.db.invoicesFor(id)[1]?.id ?? '';
    const staleFailure = await harness.webhooks.deliver(
      aWebhookEvent()
        .withEventId('evt_journey_stale')
        .ofType('payment.failed')
        .forSubscription(id)
        .forInvoice(settledInvoiceId)
        .withAmount(1900)
        .build(),
    );

    expect(staleFailure.body.status).toBe('ignored');
    expect(harness.db.subscription(id)?.status).toBe('active');
    expect(harness.provider.chargeCount).toBe(3);
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 6. The customer cancels -----------------------------------------
    const canceled = await harness.api.cancelSubscription(id);

    expect(canceled.body.status).toBe('canceled');
    expect(canceled.body.canceled_at).toBeTruthy();
    expect(harness.provider.chargeCount).toBe(3);
    expect(harness.db.invariantViolations()).toEqual([]);

    // ---- 7. Late events after cancellation change nothing ----------------
    await harness.webhooks.deliver(
      aWebhookEvent()
        .withEventId('evt_journey_zombie')
        .ofType('payment.succeeded')
        .forSubscription(id)
        .forInvoice(settledInvoiceId)
        .build(),
    );
    const billAttempt = await harness.api.billSubscription(id);

    expect(billAttempt.status).toBe(409);
    expect(harness.db.subscription(id)?.status).toBe('canceled');
    expect(harness.provider.chargeCount).toBe(3);

    // ---- The whole journey, as recorded --------------------------------
    expect(harness.db.statusHistoryFor(id)).toEqual([
      'trialing',
      'active',
      'past_due',
      'active',
      'canceled',
    ]);
    expect(harness.db.invariantViolations()).toEqual([]);

    // Three genuine billing attempts, three provider calls, three payment rows.
    expect(harness.db.paymentsFor(id)).toHaveLength(3);
    expect(harness.provider.chargeCount).toBe(3);
  });

  it('exhausts retries and cancels when the card keeps failing', async () => {
    harness.provider.willDecline();
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    const id = created.body.id;

    await harness.api.billSubscription(id);
    await harness.api.billSubscription(id);
    expect(harness.db.subscription(id)?.status).toBe('past_due');

    const final = await harness.api.billSubscription(id);

    expect(final.body.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'past_due', 'canceled']);
    // Four attempts on one invoice, four distinct idempotency keys.
    const keys = new Set(harness.db.paymentsFor(id).map((payment) => payment.idempotency_key));
    expect(keys.size).toBe(4);
    expect(harness.db.invoicesFor(id)).toHaveLength(1);
    expect(harness.db.invariantViolations()).toEqual([]);
  });
});
