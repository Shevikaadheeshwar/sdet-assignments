import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * The invariants from TEST_STRATEGY.md §8, asserted directly (strategy §12,
 * P2-13 and P2-14).
 *
 * The other suites check behaviour one scenario at a time. These check the
 * statements that must hold *whatever* happened, which is how a bug introduced
 * by some future combination of events gets caught by a test nobody wrote for
 * it specifically.
 */
describe('database invariants', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  describe('I1 — a subscription never reaches active without a successful payment', () => {
    it('holds when the first charge is declined', async () => {
      harness.provider.willDecline();

      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      expect(created.body.status).toBe('past_due');
      expect(harness.db.invariantViolations()).toEqual([]);
    });

    it('holds when a charge times out', async () => {
      harness.provider.willTimeout();

      await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      expect(harness.db.invariantViolations()).toEqual([]);
    });
  });

  describe('I6 — plan price is applied consistently at creation and at billing', () => {
    it('charges the same amount on the first attempt and on a retry', async () => {
      harness.provider.willDecline();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
      );
      await harness.api.billSubscription(created.body.id);
      await harness.api.billSubscription(created.body.id);

      for (const charge of harness.provider.charges) {
        expect(charge.amountMinor).toBe(1900);
      }
      expect(harness.db.invariantViolations()).toEqual([]);
    });
  });

  describe('I5 — persisted state always matches the API-visible result', () => {
    it('agrees at every stage of a subscription that recovers from past_due', async () => {
      harness.provider.willDecline();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      const id = created.body.id;

      const assertApiMatchesDatabase = async (): Promise<void> => {
        const fetched = await harness.api.getSubscription(id);
        const row = harness.db.subscription(id);
        expect(fetched.body.status).toBe(row?.status);
        expect(fetched.body.amount_minor).toBe(row?.amount_minor);
        expect(fetched.body.canceled_at).toBe(row?.canceled_at ?? null);
      };

      await assertApiMatchesDatabase();

      harness.provider.willSucceed();
      await harness.api.billSubscription(id);
      await assertApiMatchesDatabase();

      await harness.api.cancelSubscription(id);
      await assertApiMatchesDatabase();

      expect(harness.db.invariantViolations()).toEqual([]);
    });
  });

  describe('the invariant checker itself', () => {
    it('reports a violation when the database is deliberately corrupted', () => {
      // A checker that can only return an empty list proves nothing, so this
      // forces a contradiction past the service and confirms it is noticed.
      harness.corruptForTesting(
        "INSERT INTO subscriptions (id, customer_id, plan, status, payment_method_id," +
          " amount_minor, currency, trial_days, failed_attempts, created_at, updated_at)" +
          " VALUES ('sub_corrupt', 'cust_001', 'pro', 'active', 'pm_1', 4900, 'USD', 0, 0," +
          " '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      );

      const violations = harness.db.invariantViolations();

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('I1');
      expect(violations[0]).toContain('active with no succeeded payment');
    });
  });

  describe('I2, I3 and I4 together, under a messy sequence of events', () => {
    it('stays coherent through retries, a replay, a stale event and cancellation', async () => {
      harness.provider.willDecline();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      const id = created.body.id;
      const invoiceId = harness.db.invoicesFor(id)[0]?.id ?? '';

      harness.provider.willSucceed();
      await harness.api.billSubscription(id);
      expect(harness.db.invariantViolations()).toEqual([]);

      const stale = aWebhookEvent()
        .withEventId('evt_messy_1')
        .ofType('payment.failed')
        .forSubscription(id)
        .forInvoice(invoiceId)
        .build();
      await harness.webhooks.deliver(stale);
      await harness.webhooks.deliver(stale);
      expect(harness.db.invariantViolations()).toEqual([]);

      await harness.api.cancelSubscription(id);
      await harness.webhooks.deliver(
        aWebhookEvent()
          .withEventId('evt_messy_2')
          .ofType('payment.succeeded')
          .forSubscription(id)
          .forInvoice(invoiceId)
          .build(),
      );

      expect(harness.db.subscription(id)?.status).toBe('canceled');
      expect(harness.db.invariantViolations()).toEqual([]);
    });
  });
});
