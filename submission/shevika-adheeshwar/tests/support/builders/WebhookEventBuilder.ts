import { randomUUID } from 'node:crypto';

/**
 * Builder for inbound webhook payloads.
 *
 * Webhook scenarios differ by one field — a replayed `event_id`, a stale type, a
 * missing `invoice_id` — and the whole point of each test is that one field.
 * Restating the full literal every time would bury it.
 *
 * `omitting()` and `with()` let malformed-payload tests remove or corrupt a
 * field without reaching for `as any`.
 */
export class WebhookEventBuilder {
  private payload: Record<string, unknown> = {
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    type: 'payment.succeeded',
    subscription_id: 'sub_unknown',
    invoice_id: 'inv_unknown',
    amount: 4900,
    currency: 'USD',
  };

  withEventId(eventId: string): this {
    this.payload['event_id'] = eventId;
    return this;
  }

  ofType(type: string): this {
    this.payload['type'] = type;
    return this;
  }

  forSubscription(subscriptionId: string): this {
    this.payload['subscription_id'] = subscriptionId;
    return this;
  }

  forInvoice(invoiceId: string): this {
    this.payload['invoice_id'] = invoiceId;
    return this;
  }

  withAmount(amount: number): this {
    this.payload['amount'] = amount;
    return this;
  }

  omitting(field: string): this {
    delete this.payload[field];
    return this;
  }

  with(field: string, value: unknown): this {
    this.payload[field] = value;
    return this;
  }

  build(): Record<string, unknown> {
    return { ...this.payload };
  }
}

export function aWebhookEvent(): WebhookEventBuilder {
  return new WebhookEventBuilder();
}
