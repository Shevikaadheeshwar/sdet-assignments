import { expect } from 'vitest';

import { aSubscriptionRequest } from './builders/SubscriptionRequestBuilder';
import type { TestHarness } from './TestHarness';

export interface SubscriptionUnderTest {
  readonly subscriptionId: string;
  readonly invoiceId: string;
}

/**
 * Named starting positions for scenarios.
 *
 * Each one drives the real API to reach its state rather than writing rows
 * directly, so a scenario that starts "past_due with an unpaid invoice" has
 * genuinely been through the lifecycle to get there. Seeding the row instead
 * would quietly stop testing the state machine.
 */

/**
 * A subscription whose charge timed out: past_due, with an unpaid invoice still
 * awaiting an answer. This is the realistic setup for webhook-driven scenarios,
 * because it is exactly when a provider reports the real outcome out of band.
 */
export async function pastDueAwaitingWebhook(
  harness: TestHarness,
  customerId = 'cust_001',
): Promise<SubscriptionUnderTest> {
  const created = await harness.api.createSubscription(
    aSubscriptionRequest().forCustomer(customerId).onPlan('basic').build(),
  );
  const subscriptionId = created.body.id;

  harness.provider.willTimeout();
  const billed = await harness.api.billSubscription(subscriptionId);
  expect(billed.body.status).toBe('past_due');

  const invoiceId = harness.db.invoicesFor(subscriptionId)[0]?.id;
  if (!invoiceId) throw new Error('expected an invoice after the billing attempt');

  return { subscriptionId, invoiceId };
}

/** An active subscription that has been canceled, so it is terminal. */
export async function canceledSubscription(
  harness: TestHarness,
  customerId = 'cust_001',
): Promise<SubscriptionUnderTest> {
  harness.provider.willSucceed();
  const created = await harness.api.createSubscription(
    aSubscriptionRequest().forCustomer(customerId).onPlan('pro').build(),
  );
  const subscriptionId = created.body.id;
  const invoiceId = harness.db.invoicesFor(subscriptionId)[0]?.id ?? 'inv_missing';

  const canceled = await harness.api.cancelSubscription(subscriptionId);
  expect(canceled.body.status).toBe('canceled');

  return { subscriptionId, invoiceId };
}
