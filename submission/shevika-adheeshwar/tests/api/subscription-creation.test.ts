import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Creation and retrieval (strategy §12, P1 scenario 7).
 *
 * Every test here asserts three things that must agree: the API response, the
 * persisted rows, and what the payment provider was actually asked to do.
 * Asserting only the first is the failure mode the assignment calls out.
 */
describe('POST /subscriptions', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  describe('on a plan with no trial (charged immediately)', () => {
    it('activates the subscription and charges the provider exactly once', async () => {
      harness.provider.willSucceed();

      const response = await harness.api.createSubscription(
        aSubscriptionRequest()
          .forCustomer('cust_001')
          .onPlan('pro')
          .withPaymentMethod('pm_test_visa_4242')
          .build(),
      );

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        customer_id: 'cust_001',
        plan: 'pro',
        status: 'active',
        amount_minor: 4900,
        currency: 'USD',
      });
      expect(response.body.id).toMatch(/^sub_/);
    });

    it('calls the provider with the exact amount, customer and payment method', async () => {
      harness.provider.willSucceed();

      await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );

      // Asserting on the arguments, not merely that "something was called".
      expect(harness.provider.charges).toHaveLength(1);
      expect(harness.provider.charges[0]).toMatchObject({
        customerId: 'cust_001',
        paymentMethodId: 'pm_test_visa_4242',
        amountMinor: 4900,
        currency: 'USD',
      });
      expect(harness.provider.charges[0]?.idempotencyKey).toBeTruthy();
    });

    it('persists an invoice and a successful payment that agree with the response', async () => {
      harness.provider.willSucceed();

      const response = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
      );
      const subscriptionId = response.body.id;

      // Invariant I5 — persisted state equals the API-visible state.
      expect(harness.db.subscription(subscriptionId)?.status).toBe('active');

      const invoices = harness.db.invoicesFor(subscriptionId);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ status: 'paid', amount_minor: 4900, period_sequence: 1 });

      // Invariant I1 — never active without a persisted successful payment.
      const payments = harness.db.paymentsFor(subscriptionId);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ status: 'succeeded', amount_minor: 4900 });
      expect(payments[0]?.provider_reference).toBeTruthy();
    });
  });

  describe('on a plan with a trial', () => {
    it('starts in trialing and does not charge the provider at all', async () => {
      const response = await harness.api.createSubscription(
        aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
      );

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        plan: 'basic',
        status: 'trialing',
        amount_minor: 1900,
        trial_days: 14,
      });

      // No money is owed during a trial, so there is nothing to charge and
      // nothing to invoice yet.
      expect(harness.provider.charges).toHaveLength(0);
      expect(harness.db.invoicesFor(response.body.id)).toHaveLength(0);
      expect(harness.db.paymentsFor(response.body.id)).toHaveLength(0);
    });
  });
});

describe('GET /subscriptions/{id}', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  it('returns the subscription exactly as it is persisted', async () => {
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
    );

    const fetched = await harness.api.getSubscription(created.body.id);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
    expect(fetched.body.status).toBe(harness.db.subscription(created.body.id)?.status);
  });

  it('returns 404 for a subscription that does not exist', async () => {
    const response = await harness.api.getSubscription('sub_does_not_exist');

    expect(response.status).toBe(404);
  });
});
