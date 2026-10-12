import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { SUBSCRIPTION_STATES } from '../../src/domain/SubscriptionState';
import { TransitionTable } from '../../src/domain/TransitionTable';
import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Invalid transitions (strategy §12, P0-2 and P0-3).
 *
 * Proven twice over, deliberately: the transition table has no edge to take, and
 * the persisted row and audit trail are unchanged after the attempt. A guard
 * that only exists at one call site is the exact bug this phase prevents, so
 * asserting the rejection alone would not be enough.
 */
describe('the transition table itself', () => {
  const table = new TransitionTable();

  it('declares exactly the seven transitions in the specification', () => {
    expect(table.all()).toHaveLength(7);
  });

  it('gives canceled no outgoing edges, making it structurally terminal', () => {
    expect(table.all().filter((transition) => transition.from === 'canceled')).toEqual([]);
    expect(table.isTerminal('canceled')).toBe(true);
  });

  it('refuses every trigger from canceled, whatever it is', () => {
    for (const trigger of table.triggers()) {
      expect(table.next('canceled', trigger)).toBeUndefined();
    }
  });

  it('treats canceled as the only terminal state', () => {
    const terminal = SUBSCRIPTION_STATES.filter((state) => table.isTerminal(state));
    expect(terminal).toEqual(['canceled']);
  });
});

describe('a canceled subscription', () => {
  let harness: TestHarness;
  let subscriptionId: string;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });

    harness.provider.willSucceed();
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    subscriptionId = created.body.id;
    await harness.api.cancelSubscription(subscriptionId);
    expect(harness.db.subscription(subscriptionId)?.status).toBe('canceled');
  });

  afterEach(() => {
    harness.stop();
  });

  it('cannot be reactivated by a successful billing attempt (canceled -> active)', async () => {
    const chargesBefore = harness.provider.chargeCount;
    const historyBefore = harness.db.statusHistoryFor(subscriptionId);
    harness.provider.willSucceed();

    const response = await harness.api.billSubscription(subscriptionId);

    expect(response.status).toBe(409);
    expect(harness.db.subscription(subscriptionId)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(subscriptionId)).toEqual(historyBefore);
    // Nothing was charged and no invoice was opened for a dead subscription.
    expect(harness.provider.chargeCount).toBe(chargesBefore);
    expect(harness.db.invoicesFor(subscriptionId)).toHaveLength(1);
  });

  it('cannot be pushed to past_due by a failing billing attempt (canceled -> past_due)', async () => {
    const historyBefore = harness.db.statusHistoryFor(subscriptionId);
    const paymentsBefore = harness.db.paymentsFor(subscriptionId).length;
    harness.provider.willDecline();

    const response = await harness.api.billSubscription(subscriptionId);

    expect(response.status).toBe(409);
    expect(harness.db.subscription(subscriptionId)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(subscriptionId)).toEqual(historyBefore);
    expect(harness.db.paymentsFor(subscriptionId)).toHaveLength(paymentsBefore);
  });

  it('cannot be canceled a second time', async () => {
    const historyBefore = harness.db.statusHistoryFor(subscriptionId);

    const response = await harness.api.cancelSubscription(subscriptionId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('invalid_transition');
    // No duplicate audit row for the repeated attempt.
    expect(harness.db.statusHistoryFor(subscriptionId)).toEqual(historyBefore);
  });
});
