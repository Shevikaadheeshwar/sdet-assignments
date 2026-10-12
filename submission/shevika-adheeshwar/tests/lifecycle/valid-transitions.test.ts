import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Every valid transition in the assignment's lifecycle diagram, one test each
 * (strategy §12, P0-1).
 *
 * States are reached by driving the real transitions rather than by seeding a
 * row with the desired status. A test that writes `status = 'past_due'` straight
 * into the database proves nothing about the state machine.
 */
describe('valid lifecycle transitions', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
  });

  afterEach(() => {
    harness.stop();
  });

  /** A trialing subscription: the `basic` plan has a 14-day trial. */
  const createTrialing = async (): Promise<string> => {
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('basic').build(),
    );
    expect(response.body.status).toBe('trialing');
    return response.body.id;
  };

  /** An active subscription: `pro` has no trial, so it charges on creation. */
  const createActive = async (): Promise<string> => {
    harness.provider.willSucceed();
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    expect(response.body.status).toBe('active');
    return response.body.id;
  };

  /** A past_due subscription: `pro`, charged on creation, declined. */
  const createPastDue = async (): Promise<string> => {
    harness.provider.willDecline();
    const response = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    expect(response.body.status).toBe('past_due');
    return response.body.id;
  };

  it('1. trialing -> active when the trial ends and the first charge succeeds', async () => {
    const id = await createTrialing();
    harness.provider.willSucceed();

    const response = await harness.api.billSubscription(id);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('active');
    expect(harness.db.subscription(id)?.status).toBe('active');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'active']);
  });

  it('2. trialing -> past_due when the trial ends and the first charge fails', async () => {
    const id = await createTrialing();
    harness.provider.willDecline();

    const response = await harness.api.billSubscription(id);

    expect(response.body.status).toBe('past_due');
    expect(harness.db.subscription(id)?.status).toBe('past_due');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'past_due']);
  });

  it('3. active -> past_due when a recurring charge fails', async () => {
    const id = await createActive();
    harness.provider.willDecline();

    const response = await harness.api.billSubscription(id);

    expect(response.body.status).toBe('past_due');
    expect(harness.db.subscription(id)?.status).toBe('past_due');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'active', 'past_due']);
    // The recurring charge is a new billing period, not a retry of the first.
    expect(harness.db.invoicesFor(id)).toHaveLength(2);
  });

  it('4. past_due -> active when a retry charge succeeds', async () => {
    const id = await createPastDue();
    harness.provider.willSucceed();

    const response = await harness.api.billSubscription(id);

    expect(response.body.status).toBe('active');
    expect(harness.db.subscription(id)?.status).toBe('active');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'past_due', 'active']);
    // A retry settles the *same* unpaid invoice rather than opening a new one.
    const invoices = harness.db.invoicesFor(id);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.status).toBe('paid');
  });

  it('5. past_due -> canceled when retries are exhausted', async () => {
    const id = await createPastDue();
    harness.provider.willDecline();

    // A2.3: three failures are tolerated; the fourth exhausts retries.
    await harness.api.billSubscription(id);
    await harness.api.billSubscription(id);
    expect(harness.db.subscription(id)?.status).toBe('past_due');

    const response = await harness.api.billSubscription(id);

    expect(response.body.status).toBe('canceled');
    expect(harness.db.subscription(id)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'past_due', 'canceled']);
    expect(harness.db.subscription(id)?.canceled_at).toBeTruthy();
  });

  it('6. active -> canceled on customer cancellation', async () => {
    const id = await createActive();

    const response = await harness.api.cancelSubscription(id);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('canceled');
    expect(harness.db.subscription(id)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'active', 'canceled']);
  });

  it('7. trialing -> canceled on customer cancellation', async () => {
    const id = await createTrialing();

    const response = await harness.api.cancelSubscription(id);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('canceled');
    expect(harness.db.subscription(id)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(id)).toEqual(['trialing', 'canceled']);
    // Cancelling during a trial must not charge anything.
    expect(harness.provider.chargeCount).toBe(0);
  });
});
