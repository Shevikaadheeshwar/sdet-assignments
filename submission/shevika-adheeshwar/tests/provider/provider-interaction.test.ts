import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Mocked payment provider interaction (strategy §12, P1-7, P1-11, P1-12).
 *
 * The assignment is explicit that asserting "something was called" is not
 * enough, so every test here checks either the exact arguments or the exact
 * call count — including the cases where the correct count is zero.
 */
describe('payment provider interaction', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  describe('call arguments', () => {
    it('passes the amount, customer, payment method, currency and invoice reference', async () => {
      harness.provider.willSucceed();

      const created = await harness.api.createSubscription(
        aSubscriptionRequest()
          .forCustomer('cust_001')
          .onPlan('pro')
          .withPaymentMethod('pm_test_visa_4242')
          .build(),
      );

      const invoiceId = harness.db.invoicesFor(created.body.id)[0]?.id;
      expect(harness.provider.charges).toHaveLength(1);
      expect(harness.provider.charges[0]).toEqual({
        customerId: 'cust_001',
        paymentMethodId: 'pm_test_visa_4242',
        amountMinor: 4900,
        currency: 'USD',
        idempotencyKey: `${invoiceId}:attempt:1`,
        reference: invoiceId,
      });
    });

    it('uses the plan price, not an amount supplied by the caller', async () => {
      harness.provider.willSucceed();

      // A caller trying to set their own price. The field is simply not read.
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').with('amount', 1).build(),
      );
      await harness.api.billSubscription(created.body.id);

      // Invariant I6: the amount comes from PlanCatalog on every attempt.
      expect(harness.provider.charges).toHaveLength(1);
      expect(harness.provider.charges[0]?.amountMinor).toBe(1900);
      expect(harness.db.invoicesFor(created.body.id)[0]?.amount_minor).toBe(1900);
    });

    it('gives each billing attempt a distinct idempotency key for the same invoice', async () => {
      harness.provider.willDecline();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      await harness.api.billSubscription(created.body.id);

      const invoiceId = harness.db.invoicesFor(created.body.id)[0]?.id;
      expect(harness.provider.charges).toHaveLength(2);
      // A retry of the same unpaid invoice, so the reference is stable...
      expect(harness.provider.charges[0]?.reference).toBe(invoiceId);
      expect(harness.provider.charges[1]?.reference).toBe(invoiceId);
      // ...but each genuine attempt gets its own key, so a provider-side retry
      // of attempt 1 cannot be confused with a real attempt 2.
      expect(harness.provider.charges[0]?.idempotencyKey).toBe(`${invoiceId}:attempt:1`);
      expect(harness.provider.charges[1]?.idempotencyKey).toBe(`${invoiceId}:attempt:2`);
    });
  });

  describe('call count', () => {
    it('calls the provider exactly once per billing attempt', async () => {
      harness.provider.willDecline();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      expect(harness.provider.chargeCount).toBe(1);

      await harness.api.billSubscription(created.body.id);
      expect(harness.provider.chargeCount).toBe(2);

      await harness.api.billSubscription(created.body.id);
      expect(harness.provider.chargeCount).toBe(3);
    });

    it('does not call the provider for a subscription that starts in a trial', async () => {
      await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
      );

      expect(harness.provider.chargeCount).toBe(0);
    });

    it('does not call the provider when creation is rejected', async () => {
      await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('platinum').build(),
      );
      await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_nobody').onPlan('pro').build(),
      );
      await harness.api.createSubscription(
        aSubscriptionRequest().omitting('customer_id').onPlan('pro').build(),
      );

      expect(harness.provider.chargeCount).toBe(0);
    });

    it('does not call the provider when cancelling', async () => {
      harness.provider.willSucceed();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      const chargesAfterCreate = harness.provider.chargeCount;

      await harness.api.cancelSubscription(created.body.id);

      expect(harness.provider.chargeCount).toBe(chargesAfterCreate);
    });

    it('does not call the provider while processing a webhook', async () => {
      harness.provider.willTimeout();
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      const invoiceId = harness.db.invoicesFor(created.body.id)[0]?.id ?? '';
      const chargesBefore = harness.provider.chargeCount;

      await harness.webhooks.deliver(
        aWebhookEvent()
          .withEventId('evt_provider_1')
          .forSubscription(created.body.id)
          .forInvoice(invoiceId)
          .build(),
      );
      await harness.webhooks.deliver(
        aWebhookEvent()
          .withEventId('evt_provider_1')
          .forSubscription(created.body.id)
          .forInvoice(invoiceId)
          .build(),
      );

      expect(harness.provider.chargeCount).toBe(chargesBefore);
    });
  });

  describe('provider outcomes', () => {
    it('moves to past_due and records the decline reason on a decline', async () => {
      harness.provider.willDecline('insufficient_funds');

      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      expect(created.body.status).toBe('past_due');
      const payments = harness.db.paymentsFor(created.body.id);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        status: 'failed',
        failure_reason: 'insufficient_funds',
        provider_reference: null,
      });
      expect(harness.db.invoicesFor(created.body.id)[0]?.status).toBe('failed');
    });

    it('moves to past_due on a timeout rather than assuming either result', async () => {
      harness.provider.willTimeout();

      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      // A timeout is not a success. Treating an unanswered charge as paid is the
      // expensive version of this bug.
      expect(created.body.status).toBe('past_due');
      expect(harness.db.paymentsFor(created.body.id)[0]).toMatchObject({
        status: 'timed_out',
        failure_reason: 'provider_timeout',
      });
    });

    it('never records a successful payment for a failed charge (invariant I1)', async () => {
      harness.provider.willDecline();

      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      const succeeded = harness.db
        .paymentsFor(created.body.id)
        .filter((payment) => payment.status === 'succeeded');
      expect(succeeded).toHaveLength(0);
      expect(harness.db.subscription(created.body.id)?.status).not.toBe('active');
    });

    it('recovers to active when a later attempt succeeds', async () => {
      harness.provider.willRespondWith(
        { status: 'declined', declineCode: 'card_declined', message: 'declined' },
        { status: 'timed_out', message: 'no answer' },
      );
      const created = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      await harness.api.billSubscription(created.body.id);

      harness.provider.willSucceed('ref_recovered');
      const recovered = await harness.api.billSubscription(created.body.id);

      expect(recovered.body.status).toBe('active');
      const succeeded = harness.db
        .paymentsFor(created.body.id)
        .filter((payment) => payment.status === 'succeeded');
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0]?.provider_reference).toBe('ref_recovered');
    });
  });
});
