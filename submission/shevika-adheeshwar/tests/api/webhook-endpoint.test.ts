import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { aSubscriptionRequest } from '../support/builders/SubscriptionRequestBuilder';
import { aWebhookEvent } from '../support/builders/WebhookEventBuilder';
import { TestHarness } from '../support/TestHarness';

/**
 * Webhook handling as *transport* (strategy §12, P1-10).
 *
 * Deliberately separate from webhook business logic, which the next phase
 * covers. A forged signature and a replayed event are different failures with
 * different responses, and testing them together hides which one a regression
 * actually broke. The PR template asks for exactly this split.
 */
describe('POST /webhooks/payment-provider', () => {
  let harness: TestHarness;
  let subscriptionId: string;
  let invoiceId: string;

  beforeEach(async () => {
    harness = await TestHarness.start();
    harness.seedCustomer({ id: 'cust_001', paymentMethodId: 'pm_test_visa_4242' });

    harness.provider.willSucceed();
    const created = await harness.api.createSubscription(
      aSubscriptionRequest().forCustomer('cust_001').onPlan('pro').build(),
    );
    subscriptionId = created.body.id;
    invoiceId = harness.db.invoicesFor(subscriptionId)[0]?.id ?? 'inv_missing';
  });

  afterEach(() => {
    harness.stop();
  });

  const validEvent = (): Record<string, unknown> =>
    aWebhookEvent().forSubscription(subscriptionId).forInvoice(invoiceId).build();

  describe('signature verification', () => {
    it('accepts a correctly signed payload', async () => {
      const response = await harness.webhooks.deliver(validEvent());

      expect(response.status).toBe(200);
    });

    it('rejects a payload with no signature header', async () => {
      const response = await harness.webhooks.deliverUnsigned(validEvent());

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('missing_signature');
      expect(harness.db.webhookEvents()).toHaveLength(0);
    });

    it('rejects a forged signature', async () => {
      const response = await harness.webhooks.deliverWithSignature(validEvent(), 'not-a-signature');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_signature');
      expect(harness.db.webhookEvents()).toHaveLength(0);
    });

    it('rejects a body altered after it was signed', async () => {
      // Signed honestly for 4900, then the amount is tampered with in transit.
      const original = { ...validEvent(), amount: 4900 };
      const signature = harness.webhooks.sign(JSON.stringify(original));

      const response = await harness.webhooks.deliverWithSignature(
        { ...original, amount: 1 },
        signature,
      );

      // This is the test that proves the HMAC covers the raw body rather than
      // some re-serialised or partial view of it.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_signature');
    });
  });

  describe('payload validation', () => {
    it('rejects a body that is not valid JSON', async () => {
      const rawBody = '{"event_id": "evt_1", ';

      const response = await harness.webhooks.deliverRaw(rawBody, {
        signature: harness.webhooks.sign(rawBody),
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('malformed_payload');
    });

    it('rejects an unknown event type', async () => {
      const response = await harness.webhooks.deliver(
        aWebhookEvent()
          .forSubscription(subscriptionId)
          .forInvoice(invoiceId)
          .ofType('payment.exploded')
          .build(),
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('unsupported_event_type');
    });

    it.each(['event_id', 'type', 'subscription_id'])(
      'rejects a payload missing %s',
      async (field) => {
        const response = await harness.webhooks.deliver(
          aWebhookEvent().forSubscription(subscriptionId).forInvoice(invoiceId).omitting(field).build(),
        );

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('invalid_payload');
      },
    );

    it('rejects a non-numeric amount', async () => {
      const response = await harness.webhooks.deliver(
        aWebhookEvent()
          .forSubscription(subscriptionId)
          .forInvoice(invoiceId)
          .with('amount', 'forty nine hundred')
          .build(),
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_payload');
    });

    it('returns 404 for a subscription that does not exist', async () => {
      const response = await harness.webhooks.deliver(
        aWebhookEvent().forSubscription('sub_does_not_exist').forInvoice(invoiceId).build(),
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('subscription_not_found');
    });
  });

  describe('ordering of the two checks', () => {
    it('reports a bad signature on a malformed body, not a parse failure', async () => {
      // A2.4: the signature is verified over the raw bytes, before any parsing.
      // An attacker must not be able to probe the parser without a valid key.
      const response = await harness.webhooks.deliverRaw('{ this is not json', {
        signature: 'forged',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_signature');
    });
  });
});
