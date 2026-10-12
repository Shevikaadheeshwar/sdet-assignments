import type { Database } from '../../src/persistence/Database';
import {
  AuditLogRepository,
  InvoiceRepository,
  PaymentRepository,
  SubscriptionRepository,
} from '../../src/persistence/repositories';
import type {
  InvoiceRow,
  PaymentRow,
  SubscriptionEventRow,
  SubscriptionRow,
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

  constructor(database: Database) {
    this.subscriptions = new SubscriptionRepository(database);
    this.invoices = new InvoiceRepository(database);
    this.payments = new PaymentRepository(database);
    this.audit = new AuditLogRepository(database);
  }

  subscription(id: string): SubscriptionRow | undefined {
    return this.subscriptions.findById(id);
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

  /** The status sequence a subscription actually moved through, for lifecycle assertions. */
  statusHistoryFor(subscriptionId: string): string[] {
    return this.auditTrailFor(subscriptionId).map((event) => event.to_status);
  }
}
