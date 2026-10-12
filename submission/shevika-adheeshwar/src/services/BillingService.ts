import type { PlanConfig } from '../domain/PlanCatalog';
import type { ChargeOutcome, PaymentProvider } from '../payments/PaymentProvider';
import type {
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
} from '../persistence/repositories';
import type { InvoiceRow, SubscriptionRow } from '../persistence/rows';
import type { Clock } from '../support/clock';

import type { SubscriptionLifecycle } from './SubscriptionLifecycle';

export interface BillingServiceDependencies {
  readonly subscriptions: SubscriptionRepository;
  readonly invoices: InvoiceRepository;
  readonly payments: PaymentRepository;
  readonly lifecycle: SubscriptionLifecycle;
  readonly paymentProvider: PaymentProvider;
  readonly clock: Clock;
}

/**
 * One billing attempt: pick the invoice, charge it, record what happened, and
 * let the lifecycle decide where the subscription lands.
 *
 * Separated from SubscriptionService because the same sequence is reached from
 * three directions — creating a subscription with no trial, running a billing
 * cycle, and (from the next phase) a webhook reporting an out-of-band result.
 * Keeping it in one place is what makes "exactly one charge per billing attempt"
 * a property of the code rather than of three call sites agreeing.
 */
export class BillingService {
  constructor(private readonly deps: BillingServiceDependencies) {}

  async runBillingCycle(subscription: SubscriptionRow, plan: PlanConfig): Promise<SubscriptionRow> {
    const invoice = this.invoiceToSettle(subscription, plan);
    const attempt = this.deps.payments.findByInvoice(invoice.id).length + 1;

    const outcome = await this.deps.paymentProvider.charge({
      customerId: subscription.customer_id,
      paymentMethodId: subscription.payment_method_id,
      amountMinor: invoice.amount_minor,
      currency: invoice.currency,
      idempotencyKey: idempotencyKeyFor(invoice, attempt),
      reference: invoice.id,
    });

    return this.record(subscription, plan, invoice, outcome, attempt);
  }

  /**
   * A subscription that already owes money retries that invoice; one that does
   * not opens the next billing period. Invoice amounts come from the plan at
   * every attempt, which is invariant I6.
   */
  private invoiceToSettle(subscription: SubscriptionRow, plan: PlanConfig): InvoiceRow {
    const unpaid = this.deps.invoices.findLatestUnpaid(subscription.id);
    if (unpaid) return unpaid;

    return this.deps.invoices.insert(
      {
        subscriptionId: subscription.id,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        periodSequence: this.deps.invoices.nextPeriodSequence(subscription.id),
      },
      this.deps.clock(),
    );
  }

  private record(
    subscription: SubscriptionRow,
    plan: PlanConfig,
    invoice: InvoiceRow,
    outcome: ChargeOutcome,
    attempt: number,
  ): SubscriptionRow {
    const now = this.deps.clock();

    if (outcome.status === 'succeeded') {
      this.deps.payments.insert(
        {
          invoiceId: invoice.id,
          subscriptionId: subscription.id,
          providerReference: outcome.providerReference,
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

      // The payment row exists before the subscription can become active, so
      // invariant I1 holds by ordering rather than by assertion.
      return this.deps.lifecycle.apply(subscription, 'payment.succeeded') ?? this.reload(subscription);
    }

    this.deps.payments.insert(
      {
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        providerReference: null,
        idempotencyKey: idempotencyKeyFor(invoice, attempt),
        amountMinor: invoice.amount_minor,
        currency: invoice.currency,
        status: outcome.status === 'declined' ? 'failed' : 'timed_out',
        failureReason: outcome.status === 'declined' ? outcome.declineCode : 'provider_timeout',
      },
      now,
    );
    this.deps.invoices.updateStatus(invoice.id, 'failed', now);

    const failedAttempts = subscription.failed_attempts + 1;
    this.deps.subscriptions.setFailedAttempts(subscription.id, failedAttempts, now);

    // Retries can only be exhausted by a subscription that was already past_due;
    // a first failure from trialing or active is what puts it there.
    const exhausted =
      subscription.status === 'past_due' && failedAttempts > plan.maxFailedAttempts;

    if (exhausted) {
      return this.deps.lifecycle.apply(subscription, 'retries.exhausted') ?? this.reload(subscription);
    }

    // A repeated failure while already past_due has no edge to take. Staying put
    // is the correct outcome, not a rejected transition.
    return this.deps.lifecycle.apply(subscription, 'payment.failed') ?? this.reload(subscription);
  }

  private reload(subscription: SubscriptionRow): SubscriptionRow {
    return this.deps.subscriptions.findById(subscription.id) ?? subscription;
  }
}

/**
 * Stable per (invoice, attempt), so a provider-side retry of the same attempt
 * cannot produce a second charge (invariant I4).
 */
export function idempotencyKeyFor(invoice: InvoiceRow, attempt: number): string {
  return `${invoice.id}:attempt:${attempt}`;
}
