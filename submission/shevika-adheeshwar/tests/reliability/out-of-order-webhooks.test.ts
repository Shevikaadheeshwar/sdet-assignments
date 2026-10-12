import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import {
  canceledSubscription,
  pastDueAwaitingWebhook,
  type SubscriptionUnderTest,
} from '../support/scenarios';
import { TestHarness } from '../support/TestHarness';

/**
 * Out-of-order and stale delivery (strategy §12, P0-5 and P0-2/3). Mandatory.
 *
 * Webhooks arrive over a network and have no ordering guarantee. The two cases
 * that matter: a failure that overtakes a success for the same invoice, and any
 * event at all reaching a subscription that is already canceled.
 */
describe('reliability: a failure arriving after a success for the same invoice', () => {
  let harness: TestHarness;
  let subscription: SubscriptionUnderTest;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
    subscription = await pastDueAwaitingWebhook(harness);

    const succeeded = await harness.webhooks.deliver(
      aWebhookEvent()
        .withEventId('evt_success')
        .ofType('payment.succeeded')
        .forSubscription(subscription.subscriptionId)
        .forInvoice(subscription.invoiceId)
        .withAmount(1900)
        .build(),
    );
    expect(succeeded.body.status).toBe('applied');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('active');
  });

  afterEach(() => {
    harness.stop();
  });

  const staleFailure = (): Record<string, unknown> =>
    aWebhookEvent()
      .withEventId('evt_stale_failure')
      .ofType('payment.failed')
      .forSubscription(subscription.subscriptionId)
      .forInvoice(subscription.invoiceId)
      .withAmount(1900)
      .build();

  it('does not regress an active subscription', async () => {
    const historyBefore = harness.db.statusHistoryFor(subscription.subscriptionId);

    const response = await harness.webhooks.deliver(staleFailure());

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ignored');
    expect(response.body['reason']).toBe('stale_invoice');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('active');
    expect(harness.db.statusHistoryFor(subscription.subscriptionId)).toEqual(historyBefore);
  });

  it('leaves the settled invoice paid', async () => {
    await harness.webhooks.deliver(staleFailure());

    const invoices = harness.db.invoicesFor(subscription.subscriptionId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.status).toBe('paid');
  });

  it('records the stale event rather than silently dropping it', async () => {
    await harness.webhooks.deliver(staleFailure());

    // "We received it and decided not to act on it" is an auditable outcome.
    // Silence is indistinguishable from a lost message.
    const stored = harness.db.webhookEvent('evt_stale_failure');
    expect(stored?.outcome).toBe('ignored_stale');
  });

  it('does not increment the failed-attempt counter', async () => {
    await harness.webhooks.deliver(staleFailure());

    expect(harness.db.subscription(subscription.subscriptionId)?.failed_attempts).toBe(0);
  });
});

describe('reliability: webhooks for a canceled subscription', () => {
  let harness: TestHarness;
  let subscription: SubscriptionUnderTest;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });
    subscription = await canceledSubscription(harness);
  });

  afterEach(() => {
    harness.stop();
  });

  const eventOfType = (type: string, eventId: string): Record<string, unknown> =>
    aWebhookEvent()
      .withEventId(eventId)
      .ofType(type)
      .forSubscription(subscription.subscriptionId)
      .forInvoice(subscription.invoiceId)
      .withAmount(4900)
      .build();

  it('never reactivates a canceled subscription', async () => {
    const historyBefore = harness.db.statusHistoryFor(subscription.subscriptionId);

    const response = await harness.webhooks.deliver(eventOfType('payment.succeeded', 'evt_zombie'));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ignored');
    expect(response.body['reason']).toBe('terminal_subscription');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('canceled');
    expect(harness.db.statusHistoryFor(subscription.subscriptionId)).toEqual(historyBefore);
  });

  it('does not push a canceled subscription to past_due either', async () => {
    const response = await harness.webhooks.deliver(eventOfType('payment.failed', 'evt_late_fail'));

    expect(response.body.status).toBe('ignored');
    expect(harness.db.subscription(subscription.subscriptionId)?.status).toBe('canceled');
  });

  it('writes no payment row for an event it refused to act on', async () => {
    const paymentsBefore = harness.db.paymentsFor(subscription.subscriptionId);

    await harness.webhooks.deliver(eventOfType('payment.succeeded', 'evt_zombie_2'));
    await harness.webhooks.deliver(eventOfType('payment.failed', 'evt_zombie_3'));

    expect(harness.db.paymentsFor(subscription.subscriptionId)).toEqual(paymentsBefore);
  });

  it('records every refused event for audit', async () => {
    await harness.webhooks.deliver(eventOfType('payment.succeeded', 'evt_audit_1'));
    await harness.webhooks.deliver(eventOfType('payment.failed', 'evt_audit_2'));

    expect(harness.db.webhookEvent('evt_audit_1')?.outcome).toBe('ignored_terminal');
    expect(harness.db.webhookEvent('evt_audit_2')?.outcome).toBe('ignored_terminal');
  });
});
