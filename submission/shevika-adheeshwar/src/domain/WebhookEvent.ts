import { DomainError } from './errors';

/** The event types the provider sends, per the assignment's domain description. */
export const WEBHOOK_EVENT_TYPES = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly subscriptionId: string;
  readonly invoiceId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError(400, 'invalid_payload', `${field} is required`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DomainError(400, 'invalid_payload', `${field} must be a number`);
  }
  return value;
}

/**
 * Turns an untrusted parsed body into a typed event, or rejects it.
 *
 * Kept separate from the HTTP layer so the shape rules are testable on their own
 * and are not entangled with status codes. An unsupported type is distinguished
 * from a malformed one because they mean different things operationally: the
 * first is a provider feature we do not handle yet, the second is a bug or an
 * attack.
 */
export function parseWebhookEvent(body: unknown): WebhookEvent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(400, 'invalid_payload', 'Body must be a JSON object');
  }

  const raw = body as Record<string, unknown>;

  const eventId = requireString(raw['event_id'], 'event_id');
  const type = requireString(raw['type'], 'type');
  const subscriptionId = requireString(raw['subscription_id'], 'subscription_id');

  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new DomainError(
      400,
      'unsupported_event_type',
      `Unsupported event type ${type}. Supported: ${WEBHOOK_EVENT_TYPES.join(', ')}`,
    );
  }

  const invoiceId = raw['invoice_id'];
  if (invoiceId !== undefined && invoiceId !== null && typeof invoiceId !== 'string') {
    throw new DomainError(400, 'invalid_payload', 'invoice_id must be a string');
  }

  const currency = raw['currency'];
  if (currency !== undefined && currency !== null && typeof currency !== 'string') {
    throw new DomainError(400, 'invalid_payload', 'currency must be a string');
  }

  return {
    eventId,
    type: type as WebhookEventType,
    subscriptionId,
    invoiceId: (invoiceId as string | undefined) ?? null,
    amountMinor: optionalNumber(raw['amount'], 'amount'),
    currency: (currency as string | undefined) ?? null,
  };
}
