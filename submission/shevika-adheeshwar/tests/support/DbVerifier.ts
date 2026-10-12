import type { Database } from '../../src/persistence/Database';
import {
  AuditLogRepository,
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
  WebhookEventRepository,
} from '../../src/persistence/repositories';
import type {
  InvoiceRow,
  PaymentRow,
  SubscriptionEventRow,
  SubscriptionRow,
  WebhookEventRow,
} from '../../src/persistence/rows';

/**
 * The persistence verification layer.
 *
 * Tests read state through the same repositories the service writes it through,
 * rather than through raw SQL copied into test bodies. That keeps assertions
 * readable and means a schema change breaks loudly in one place.
 */
export class DbVerifier {
  private readonly subscriptions: SubscriptionRepository;
  private readonly invoices: InvoiceRepository;
  private readonly payments: PaymentRepository;
  private readonly audit: AuditLogRepository;
  private readonly webhookEventRepository: WebhookEventRepository;

  constructor(database: Database) {
    this.subscriptions = new SubscriptionRepository(database);
    this.invoices = new InvoiceRepository(database);
    this.payments = new PaymentRepository(database);
    this.audit = new AuditLogRepository(database);
    this.webhookEventRepository = new WebhookEventRepository(database);
  }

  subscription(id: string): SubscriptionRow | undefined {
    return this.subscriptions.findById(id);
  }

  /** Used by rejection tests to prove nothing was written at all. */
  subscriptionCount(): number {
    return this.subscriptions.countAll();
  }

  invoicesFor(subscriptionId: string): InvoiceRow[] {
    return this.invoices.findBySubscription(subscriptionId);
  }

  paymentsFor(subscriptionId: string): PaymentRow[] {
    return this.payments.findBySubscription(subscriptionId);
  }

  auditTrailFor(subscriptionId: string): SubscriptionEventRow[] {
    return this.audit.findBySubscription(subscriptionId);
  }

  /** Every webhook the service recorded, including ones it decided to ignore. */
  webhookEvents(): WebhookEventRow[] {
    return this.webhookEventRepository.findAll();
  }

  webhookEvent(eventId: string): WebhookEventRow | undefined {
    return this.webhookEventRepository.findById(eventId);
  }

  /**
   * Checks the invariants from TEST_STRATEGY.md §8 against every subscription in
   * the database, returning a readable description of anything broken.
   *
   * This exists so a scenario can assert "and the database is still coherent"
   * at each step, instead of each test hand-picking the two or three columns its
   * author happened to think about. Returning descriptions rather than a boolean
   * means a failure says what broke, not merely that something did.
   */
  invariantViolations(): string[] {
    const violations: string[] = [];

    for (const subscription of this.subscriptions.findAll()) {
      const invoices = this.invoicesFor(subscription.id);
      const payments = this.paymentsFor(subscription.id);
      const history = this.auditTrailFor(subscription.id);
      const id = subscription.id;

      // I1 — never active without at least one succeeded payment.
      if (
        subscription.status === 'active' &&
        !payments.some((payment) => payment.status === 'succeeded')
      ) {
        violations.push(`I1: ${id} is active with no succeeded payment`);
      }

      // I7 — no contradictory records.
      if (
        subscription.status === 'active' &&
        invoices.length > 0 &&
        invoices.every((invoice) => invoice.status === 'failed')
      ) {
        violations.push(`I7: ${id} is active but every invoice on record failed`);
      }

      // I2 — canceled is terminal, so nothing may follow it in the audit trail.
      const canceledAt = history.findIndex((event) => event.to_status === 'canceled');
      if (canceledAt >= 0 && canceledAt !== history.length - 1) {
        violations.push(`I2: ${id} recorded a transition after being canceled`);
      }

      // I5 — the audit trail must end where the subscription row says it is.
      const last = history[history.length - 1];
      if (last && last.to_status !== subscription.status) {
        violations.push(
          `I5: ${id} is ${subscription.status} but its audit trail ends at ${last.to_status}`,
        );
      }

      // I4 — one payment per billing attempt.
      const keys = new Set(payments.map((payment) => payment.idempotency_key));
      if (keys.size !== payments.length) {
        violations.push(`I4: ${id} has payments sharing an idempotency key`);
      }

      // I6 — invoice amounts follow the plan price recorded on the subscription.
      for (const invoice of invoices) {
        if (invoice.amount_minor !== subscription.amount_minor) {
          violations.push(
            `I6: invoice ${invoice.id} is ${invoice.amount_minor} but the plan charges ${subscription.amount_minor}`,
          );
        }
      }

      // Referential coherence: every payment settles one of this subscription's invoices.
      const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
      for (const payment of payments) {
        if (!invoiceIds.has(payment.invoice_id)) {
          violations.push(`payment ${payment.id} references invoice ${payment.invoice_id} of another subscription`);
        }
      }

      // A canceled subscription must carry the timestamp that says so.
      if (subscription.status === 'canceled' && !subscription.canceled_at) {
        violations.push(`${id} is canceled but has no canceled_at timestamp`);
      }
    }

    return violations;
  }

  /** The status sequence a subscription actually moved through, for lifecycle assertions. */
  statusHistoryFor(subscriptionId: string): string[] {
    return this.auditTrailFor(subscriptionId).map((event) => event.to_status);
  }
}
