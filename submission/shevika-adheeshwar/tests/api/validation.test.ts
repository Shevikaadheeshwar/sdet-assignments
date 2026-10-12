import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Validation failures (strategy §12, P1-8 and P1-9).
 *
 * Each case asserts three things, because a rejected request that still left a
 * row behind or still charged a card is a worse bug than a wrong status code:
 * the response, the absence of persistence, and the absence of a provider call.
 */
describe('subscription creation validation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
    // A customer with no stored payment method, to test the fallback path.
    harness.seedCustomer({ id: 'cust_no_pm', paymentMethodId: null });
  });

  afterEach(() => {
    harness.stop();
  });

  const expectNothingHappened = (): void => {
    expect(harness.db.subscriptionCount()).toBe(0);
    expect(harness.provider.chargeCount).toBe(0);
  };

  it('rejects an unknown plan with 400', async () => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('platinum').build(),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unknown_plan');
    // The message names the valid options, so the caller can fix it.
    expect(response.body.error.message).toContain('basic');
    expectNothingHappened();
  });

  it('rejects a missing customer_id with 400', async () => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().omitting('customer_id').build(),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('missing_customer_id');
    expectNothingHappened();
  });

  it('rejects an unknown customer with 404', async () => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_does_not_exist').build(),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('unknown_customer');
    expectNothingHappened();
  });

  it('rejects a request with no payment method and no stored default', async () => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_no_pm').omitting('payment_method_id').build(),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('missing_payment_method');
    expectNothingHappened();
  });

  it('falls back to the customer default payment method when none is supplied', async () => {
    harness.provider.willSucceed();

    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').omitting('payment_method_id').build(),
    );

    expect(response.status).toBe(201);
    expect(response.body.payment_method_id).toBe('pm_test_visa_4242');
    expect(harness.provider.charges[0]?.paymentMethodId).toBe('pm_test_visa_4242');
  });

  it('rejects a plan supplied as the wrong type', async () => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').with('plan', { name: 'pro' }).build(),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unknown_plan');
    expectNothingHappened();
  });

  it('rejects an entirely empty body without crashing', async () => {
    const response = await harness.api.createSubscription({});

    expect(response.status).toBe(400);
    expectNothingHappened();
  });
});

describe('cancellation validation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  it('returns 404 when cancelling a subscription that does not exist', async () => {
    const response = await harness.api.cancelSubscription('sub_nope');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('subscription_not_found');
  });

  it('returns 409 when cancelling an already-canceled subscription', async () => {
    harness.provider.willSucceed();
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    await harness.api.cancelSubscription(created.body.id);
    const historyBefore = harness.db.statusHistoryFor(created.body.id);

    const response = await harness.api.cancelSubscription(created.body.id);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('invalid_transition');
    expect(harness.db.statusHistoryFor(created.body.id)).toEqual(historyBefore);
  });
});
