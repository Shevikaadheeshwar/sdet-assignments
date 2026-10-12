import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import { pastDueAwaitingWebhook, type SubscriptionUnderTest } from '../support/scenarios';
import { TestHarness } from '../support/TestHarness';

/**
 * Duplicate webhook delivery (strategy §12, P0-4). Mandatory coverage.
 *
 * A payment provider redelivers. The service must apply the event exactly once
 * and produce no second invoice, payment, audit row or provider call — and it
 * must say so without returning an error, since a provider that receives a 4xx
 * will simply keep retrying.
 */
describe('reliability: duplicate webhook delivery', () => {
  let harness: TestHarness;
  let subscription: SubscriptionUnderTest;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
    subscription = await pastDueAwaitingWebhook(harness);
  });

  afterEach(() => {
    harness.stop();
  });

  const paymentSucceeded = (eventId: string): Record<string, unknown> =>
    aWebhookEvent()
      .withEventId(eventId)
      .ofType('payment.succeeded')
      .forSubscription(subscription.subscriptionId)
      .forInvoice(subscription.invoiceId)
      .withAmount(1900)
      .build();

  it('applies the transition exactly once for a repeated event_id', async () => {
    const first = await harness.webhooks.deliver(paymentSucceeded('evt_replay_1'));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('applied');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('active');

    const historyAfterFirst = harness.db.statusHistoryFor(subscription.subscriptionId);

    const second = await harness.webhooks.deliver(paymentSucceeded('evt_replay_1'));

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('active');
    // No second transition, so no second audit row.
    expect(harness.db.statusHistoryFor(subscription.subscriptionId)).toEqual(historyAfterFirst);
  });

  it('answers a replay with 200 rather than an error', async () => {
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_2'));

    const replay = await harness.webhooks.deliver(paymentSucceeded('evt_replay_2'));

    // A redelivering provider is behaving correctly. Answering 4xx would invite
    // it to retry forever.
    expect(replay.status).toBe(200);
  });

  it('creates no duplicate invoice or payment row on replay', async () => {
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_3'));
    const invoicesAfterFirst = harness.db.invoicesFor(subscription.subscriptionId);
    const paymentsAfterFirst = harness.db.paymentsFor(subscription.subscriptionId);

    await harness.webhooks.deliver(paymentSucceeded('evt_replay_3'));
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_3'));

    expect(harness.db.invoicesFor(subscription.subscriptionId)).toEqual(invoicesAfterFirst);
    expect(harness.db.paymentsFor(subscription.subscriptionId)).toEqual(paymentsAfterFirst);
  });

  it('stores the event once, however many times it is delivered', async () => {
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_4'));
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_4'));
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_4'));

    const stored = harness.db.webhookEvents().filter((e) => e.event_id === 'evt_replay_4');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe('applied');
  });

  it('never charges the provider while processing a webhook, replayed or not', async () => {
    const chargesBefore = harness.provider.chargeCount;

    await harness.webhooks.deliver(paymentSucceeded('evt_replay_5'));
    await harness.webhooks.deliver(paymentSucceeded('evt_replay_5'));

    // Webhooks report charges that already happened; they never initiate one.
    expect(harness.provider.chargeCount).toBe(chargesBefore);
  });

  it('treats two genuinely different events as two events', async () => {
    const first = await harness.webhooks.deliver(paymentSucceeded('evt_distinct_a'));
    const second = await harness.webhooks.deliver(paymentSucceeded('evt_distinct_b'));

    expect(first.body.status).toBe('applied');
    // Same invoice, already paid by the first: the second is stale, not a
    // duplicate. Distinguishing the two is the point.
    expect(second.body.status).toBe('ignored');
    expect(harness.db.webhookEvents()).toHaveLength(2);
  });
});
