import { DomainError } from '../domain/errors';
import type { PlanCatalog, PlanConfig } from '../domain/PlanCatalog';
import type {
  AuditLogRepository,
  CustomerRepository,
  InvoiceRepository,
  SubscriptionRepository,
} from '../persistence/repositories';
import type { SubscriptionRow } from '../persistence/rows';
import type { Clock } from '../support/clock';

import type { BillingService } from './BillingService';
import type { SubscriptionLifecycle } from './SubscriptionLifecycle';

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
  readonly audit: AuditLogRepository;
  readonly lifecycle: SubscriptionLifecycle;
  readonly billing: BillingService;
  readonly clock: Clock;
}

/**
 * The subscription use cases: create, read, cancel, and run a billing cycle.
 *
 * This service never writes the status column itself. Every state change goes
 * through SubscriptionLifecycle, which is the only code that can move a
 * subscription — so a transition cannot be introduced here by accident.
 */
export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDependencies) {}

  async create(command: CreateSubscriptionCommand): Promise<SubscriptionRow> {
    const { plan, customerId, paymentMethodId } = this.validate(command);
    const now = this.deps.clock();

    // Every subscription is born trialing: the lifecycle's entry state. A plan
    // with no trial simply has its trial end immediately, so it leaves on the
    // same edge a 14-day trial would.
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

    return this.deps.billing.runBillingCycle(subscription, plan);
  }

  findById(id: string): SubscriptionRow {
    return this.requireById(id);
  }

  cancel(id: string): SubscriptionRow {
    const subscription = this.requireById(id);

    const canceled = this.deps.lifecycle.apply(subscription, 'cancel.requested', {
      auditTrigger: 'api.cancel',
    });

    if (!canceled) {
      throw new DomainError(
        409,
        'invalid_transition',
        `Cannot cancel a subscription in state ${subscription.status}`,
      );
    }

    this.deps.invoices.voidOpen(subscription.id, this.deps.clock());
    return canceled;
  }

  /**
   * Runs a billing cycle. Stands in for a scheduler (A2.2) so tests control when
   * billing happens rather than waiting on a clock.
   */
  async bill(id: string): Promise<SubscriptionRow> {
    const subscription = this.requireById(id);

    // Checked before anything is charged: a terminal subscription must not reach
    // the payment provider at all, let alone open an invoice.
    if (this.deps.lifecycle.isTerminal(subscription)) {
      throw new DomainError(
        409,
        'invalid_transition',
        `Cannot bill a subscription in state ${subscription.status}`,
      );
    }

    return this.deps.billing.runBillingCycle(subscription, this.requirePlan(subscription));
  }

  private requireById(id: string): SubscriptionRow {
    const subscription = this.deps.subscriptions.findById(id);
    if (!subscription) {
      throw new DomainError(404, 'subscription_not_found', `No subscription with id ${id}`);
    }
    return subscription;
  }

  private requirePlan(subscription: SubscriptionRow): PlanConfig {
    const plan = this.deps.plans.get(subscription.plan);
    if (!plan) {
      throw new DomainError(
        500,
        'unknown_plan_on_subscription',
        `Subscription ${subscription.id} references unknown plan ${subscription.plan}`,
      );
    }
    return plan;
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
}
