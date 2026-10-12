import { DomainError } from '../domain/errors';
import type { PlanCatalog } from '../domain/PlanCatalog';
import type { WebhookEvent } from '../domain/WebhookEvent';
import type { Database } from '../persistence/Database';
import type {
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
  WebhookEventRepository,
} from '../persistence/repositories';
import type { InvoiceRow, SubscriptionRow, WebhookOutcome } from '../persistence/rows';
import type { Clock } from '../support/clock';

import { idempotencyKeyFor } from './BillingService';
import type { SubscriptionLifecycle } from './SubscriptionLifecycle';

export type WebhookProcessingResult =
  | { readonly status: 'applied'; readonly subscription: SubscriptionRow }
  | { readonly status: 'duplicate' }
  | { readonly status: 'ignored'; readonly reason: 'stale_invoice' | 'terminal_subscription' };

export interface WebhookProcessorDependencies {
  readonly database: Database;
  readonly plans: PlanCatalog;
  readonly subscriptions: SubscriptionRepository;
  readonly invoices: InvoiceRepository;
  readonly payments: PaymentRepository;
  readonly webhookEvents: WebhookEventRepository;
  readonly lifecycle: SubscriptionLifecycle;
  readonly clock: Clock;
}

/** sql.js surfaces constraint violations as plain Errors, so match the message. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

/**
 * Applies an inbound webhook, exactly once.
 *
 * The event row is inserted *first*, inside the same transaction as its effects.
 * `webhook_events.event_id` is a PRIMARY KEY, so a redelivery fails that insert,
 * the transaction rolls back, and nothing downstream ever ran. Idempotency is
 * therefore a property of the database rather than of an `if (alreadySeen)`
 * check that a future call site could bypass — and because it is a constraint,
 * it holds under concurrent delivery too, where a read-then-write check is a
 * race.
 *
 * This processor never calls the payment provider. Webhooks report charges that
 * already happened; treating one as a reason to charge again is how duplicate
 * billing starts.
 */
export class WebhookProcessor {
  constructor(private readonly deps: WebhookProcessorDependencies) {}

  process(event: WebhookEvent, rawPayload: string): WebhookProcessingResult {
    const subscription = this.deps.subscriptions.findById(event.subscriptionId);
    if (!subscription) {
      throw new DomainError(
        404,
        'subscription_not_found',
        `No subscription with id ${event.subscriptionId}`,
      );
    }

    const invoice = this.resolveInvoice(event, subscription);
    const decision = this.decide(subscription, invoice);

    try {
      return this.deps.database.transaction(() => {
        // First, so a replay aborts before anything below it can happen.
        this.deps.webhookEvents.insert(
          {
            eventId: event.eventId,
            type: event.type,
            subscriptionId: subscription.id,
            invoiceId: invoice?.id ?? null,
            payload: rawPayload,
            outcome: decision,
          },
          this.deps.clock(),
        );

        if (decision !== 'applied') {
          return { status: 'ignored', reason: reasonFor(decision) } as const;
        }

        return { status: 'applied', subscription: this.apply(event, subscription, invoice) } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'duplicate' };
      }
      throw error;
    }
  }

  private resolveInvoice(event: WebhookEvent, subscription: SubscriptionRow): InvoiceRow | undefined {
    if (!event.invoiceId) {
      throw new DomainError(400, 'invalid_payload', 'invoice_id is required for payment events');
    }

    const invoice = this.deps.invoices.findById(event.invoiceId);
    if (!invoice) {
      throw new DomainError(404, 'invoice_not_found', `No invoice with id ${event.invoiceId}`);
    }
    if (invoice.subscription_id !== subscription.id) {
      throw new DomainError(
        400,
        'invoice_subscription_mismatch',
        `Invoice ${invoice.id} does not belong to subscription ${subscription.id}`,
      );
    }
    return invoice;
  }

  /**
   * Decides the event's fate before any of it is written, so the outcome stored
   * on the event row is the one that actually happened.
   */
  private decide(subscription: SubscriptionRow, invoice: InvoiceRow | undefined): WebhookOutcome {
    // A canceled subscription has no outgoing edges at all, so nothing can move
    // it — the table says so, and this records why we did not try.
    if (this.deps.lifecycle.isTerminal(subscription)) {
      return 'ignored_terminal';
    }

    // An invoice that has already reached a terminal status is settled. A later
    // event about it arrived out of order and must not undo the result.
    if (invoice && (invoice.status === 'paid' || invoice.status === 'refunded')) {
      return 'ignored_stale';
    }

    return 'applied';
  }

  private apply(
    event: WebhookEvent,
    subscription: SubscriptionRow,
    invoice: InvoiceRow | undefined,
  ): SubscriptionRow {
    if (!invoice) {
      throw new DomainError(400, 'invalid_payload', 'invoice_id is required for payment events');
    }

    switch (event.type) {
      case 'payment.succeeded':
        return this.applySuccess(event, subscription, invoice);
      case 'payment.failed':
        return this.applyFailure(event, subscription, invoice);
      case 'payment.refunded':
        return this.applyRefund(subscription, invoice);
    }
  }

  private applySuccess(
    event: WebhookEvent,
    subscription: SubscriptionRow,
    invoice: InvoiceRow,
  ): SubscriptionRow {
    const now = this.deps.clock();
    const attempt = this.deps.payments.findByInvoice(invoice.id).length + 1;

    this.deps.payments.insert(
      {
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        providerReference: event.eventId,
        idempotencyKey: idempotencyKeyFor(invoice, attempt),
        amountMinor: invoice.amount_minor,
        currency: invoice.currency,
        status: 'succeeded',
        failureReason: null,
      },
      now,
    );
    this.deps.invoices.updateStatus(invoice.id, 'paid', now);
    this.deps.subscriptions.setFailedAttempts(subscription.id, 0, now);

    return (
      this.deps.lifecycle.apply(subscription, 'payment.succeeded', {
        sourceEventId: event.eventId,
      }) ?? this.reload(subscription)
    );
  }

  private applyFailure(
    event: WebhookEvent,
    subscription: SubscriptionRow,
    invoice: InvoiceRow,
  ): SubscriptionRow {
    const now = this.deps.clock();
    const attempt = this.deps.payments.findByInvoice(invoice.id).length + 1;

    this.deps.payments.insert(
      {
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        providerReference: event.eventId,
        idempotencyKey: idempotencyKeyFor(invoice, attempt),
        amountMinor: invoice.amount_minor,
        currency: invoice.currency,
        status: 'failed',
        failureReason: 'provider_reported_failure',
      },
      now,
    );
    this.deps.invoices.updateStatus(invoice.id, 'failed', now);

    const plan = this.deps.plans.get(subscription.plan);
    const failedAttempts = subscription.failed_attempts + 1;
    this.deps.subscriptions.setFailedAttempts(subscription.id, failedAttempts, now);

    const exhausted =
      subscription.status === 'past_due' &&
      plan !== undefined &&
      failedAttempts > plan.maxFailedAttempts;

    const trigger = exhausted ? 'retries.exhausted' : 'payment.failed';

    return (
      this.deps.lifecycle.apply(subscription, trigger, { sourceEventId: event.eventId }) ??
      this.reload(subscription)
    );
  }

  /**
   * A refund settles the invoice but moves no state: the specification's
   * lifecycle defines no edge for it, and inventing one would be the kind of
   * guessing the assignment asks to avoid. It is recorded and nothing more.
   */
  private applyRefund(subscription: SubscriptionRow, invoice: InvoiceRow): SubscriptionRow {
    const now = this.deps.clock();
    this.deps.invoices.updateStatus(invoice.id, 'refunded', now);
    return this.reload(subscription);
  }

  private reload(subscription: SubscriptionRow): SubscriptionRow {
    return this.deps.subscriptions.findById(subscription.id) ?? subscription;
  }
}

function reasonFor(outcome: WebhookOutcome): 'stale_invoice' | 'terminal_subscription' {
  return outcome === 'ignored_terminal' ? 'terminal_subscription' : 'stale_invoice';
}
