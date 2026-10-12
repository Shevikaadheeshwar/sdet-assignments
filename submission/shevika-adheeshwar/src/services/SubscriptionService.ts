import { DomainError } from '../domain/errors';
import type { PlanCatalog, PlanConfig } from '../domain/PlanCatalog';
import type { ChargeOutcome, PaymentProvider } from '../payments/PaymentProvider';
import type {
  AuditLogRepository,
  CustomerRepository,
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
} from '../persistence/repositories';
import type { InvoiceRow, SubscriptionRow } from '../persistence/rows';
import type { Clock } from '../support/clock';

export interface CreateSubscriptionCommand {
  readonly customer_id?: unknown;
  readonly plan?: unknown;
  readonly payment_method_id?: unknown;
}

export interface SubscriptionServiceDependencies {
  readonly plans: PlanCatalog;
  readonly customers: CustomerRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly invoices: InvoiceRepository;
  readonly payments: PaymentRepository;
  readonly audit: AuditLogRepository;
  readonly paymentProvider: PaymentProvider;
  readonly clock: Clock;
}

/**
 * Subscription creation and retrieval.
 *
 * Every subscription is born `trialing`, which is the lifecycle's documented
 * entry state. A plan with no trial simply has its trial end immediately, so
 * creating one takes the same `trialing -> active` / `trialing -> past_due` edge
 * as a trial that expires later. One code path, two triggers — rather than a
 * separate "created active" path that would need its own invariants.
 */
export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDependencies) {}

  async create(command: CreateSubscriptionCommand): Promise<SubscriptionRow> {
    const { plan, customerId, paymentMethodId } = this.validate(command);
    const now = this.deps.clock();

    const subscription = this.deps.subscriptions.insert(
      {
        customerId,
        plan: plan.id,
        status: 'trialing',
        paymentMethodId,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        trialDays: plan.trialDays,
      },
      now,
    );

    this.deps.audit.append(
      {
        subscriptionId: subscription.id,
        fromStatus: null,
        toStatus: 'trialing',
        trigger: 'subscription.created',
        sourceEventId: null,
      },
      now,
    );

    if (plan.trialDays > 0) {
      return subscription;
    }

    await this.chargeFirstPeriod(subscription, plan);
    return this.requireById(subscription.id);
  }

  findById(id: string): SubscriptionRow {
    return this.requireById(id);
  }

  private requireById(id: string): SubscriptionRow {
    const subscription = this.deps.subscriptions.findById(id);
    if (!subscription) {
      throw new DomainError(404, 'subscription_not_found', `No subscription with id ${id}`);
    }
    return subscription;
  }

  private validate(command: CreateSubscriptionCommand): {
    plan: PlanConfig;
    customerId: string;
    paymentMethodId: string;
  } {
    const plan = this.deps.plans.get(command.plan);
    if (!plan) {
      throw new DomainError(
        400,
        'unknown_plan',
        `Unknown plan. Known plans: ${this.deps.plans.ids().join(', ')}`,
      );
    }

    if (typeof command.customer_id !== 'string' || command.customer_id.length === 0) {
      throw new DomainError(400, 'missing_customer_id', 'customer_id is required');
    }

    const customer = this.deps.customers.findById(command.customer_id);
    if (!customer) {
      throw new DomainError(404, 'unknown_customer', `No customer with id ${command.customer_id}`);
    }

    const paymentMethodId =
      typeof command.payment_method_id === 'string' && command.payment_method_id.length > 0
        ? command.payment_method_id
        : customer.default_payment_method_id;

    if (!paymentMethodId) {
      throw new DomainError(400, 'missing_payment_method', 'payment_method_id is required');
    }

    return { plan, customerId: customer.id, paymentMethodId };
  }

  /**
   * Opens the first invoice and attempts to settle it. The subscription only
   * reaches `active` once a succeeded payment row exists, which is invariant I1
   * enforced by ordering rather than asserted after the fact.
   */
  private async chargeFirstPeriod(subscription: SubscriptionRow, plan: PlanConfig): Promise<void> {
    const now = this.deps.clock();
    const invoice = this.deps.invoices.insert(
      {
        subscriptionId: subscription.id,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        periodSequence: this.deps.invoices.nextPeriodSequence(subscription.id),
      },
      now,
    );

    const outcome = await this.deps.paymentProvider.charge({
      customerId: subscription.customer_id,
      paymentMethodId: subscription.payment_method_id,
      amountMinor: invoice.amount_minor,
      currency: invoice.currency,
      idempotencyKey: idempotencyKeyFor(invoice, 1),
      reference: invoice.id,
    });

    this.recordOutcome(subscription, invoice, outcome);
  }

  private recordOutcome(
    subscription: SubscriptionRow,
    invoice: InvoiceRow,
    outcome: ChargeOutcome,
  ): void {
    const now = this.deps.clock();
    const attempt = this.deps.payments.findByInvoice(invoice.id).length + 1;

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
      this.transition(subscription, 'active', 'payment.succeeded');
      return;
    }

    const failureReason = outcome.status === 'declined' ? outcome.declineCode : 'provider_timeout';
    this.deps.payments.insert(
      {
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        providerReference: null,
        idempotencyKey: idempotencyKeyFor(invoice, attempt),
        amountMinor: invoice.amount_minor,
        currency: invoice.currency,
        status: outcome.status === 'declined' ? 'failed' : 'timed_out',
        failureReason,
      },
      now,
    );
    this.deps.invoices.updateStatus(invoice.id, 'failed', now);
    this.deps.subscriptions.setFailedAttempts(subscription.id, subscription.failed_attempts + 1, now);
    this.transition(subscription, 'past_due', 'payment.failed');
  }

  private transition(
    subscription: SubscriptionRow,
    to: 'active' | 'past_due',
    trigger: string,
  ): void {
    const now = this.deps.clock();
    this.deps.subscriptions.updateStatus(subscription.id, to, now);
    this.deps.audit.append(
      {
        subscriptionId: subscription.id,
        fromStatus: subscription.status,
        toStatus: to,
        trigger,
        sourceEventId: null,
      },
      now,
    );
  }
}

/**
 * Stable per (invoice, attempt), so the provider can safely retry the same call
 * and a replayed billing attempt cannot produce a second charge (invariant I4).
 */
export function idempotencyKeyFor(invoice: InvoiceRow, attempt: number): string {
  return `${invoice.id}:attempt:${attempt}`;
}
