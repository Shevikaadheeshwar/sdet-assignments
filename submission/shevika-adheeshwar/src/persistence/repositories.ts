import type { SubscriptionStatus } from '../domain/SubscriptionState';
import { newId } from '../support/ids';

import type { Database } from './Database';
import type {
  CustomerRow,
  InvoiceRow,
  InvoiceStatus,
  PaymentRow,
  PaymentStatus,
  SubscriptionEventRow,
  SubscriptionRow,
} from './rows';

/**
 * Repositories — the only place SQL is written.
 *
 * Keeping queries here rather than inline in services and tests is what lets a
 * persistence assertion read as a business statement ("this subscription has one
 * succeeded payment") instead of a SELECT. It also means the test suite verifies
 * state through the same accessors the service writes it through, so a column
 * rename cannot leave tests passing against a stale query.
 */

export class CustomerRepository {
  constructor(private readonly db: Database) {}

  insert(customer: { id: string; email: string; paymentMethodId: string | null }, now: string): void {
    this.db.run('INSERT INTO customers (id, email, default_payment_method_id, created_at) VALUES (?, ?, ?, ?)', [
      customer.id,
      customer.email,
      customer.paymentMethodId,
      now,
    ]);
  }

  findById(id: string): CustomerRow | undefined {
    return this.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]);
  }
}

export class SubscriptionRepository {
  constructor(private readonly db: Database) {}

  insert(subscription: {
    customerId: string;
    plan: string;
    status: SubscriptionStatus;
    paymentMethodId: string;
    amountMinor: number;
    currency: string;
    trialDays: number;
  }, now: string): SubscriptionRow {
    const id = newId('sub');
    this.db.run(
      `INSERT INTO subscriptions
         (id, customer_id, plan, status, payment_method_id, amount_minor, currency,
          trial_days, failed_attempts, created_at, updated_at, canceled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        id,
        subscription.customerId,
        subscription.plan,
        subscription.status,
        subscription.paymentMethodId,
        subscription.amountMinor,
        subscription.currency,
        subscription.trialDays,
        now,
        now,
      ],
    );
    const inserted = this.findById(id);
    if (!inserted) throw new Error(`subscription ${id} vanished immediately after insert`);
    return inserted;
  }

  findById(id: string): SubscriptionRow | undefined {
    return this.db.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ?', [id]);
  }

  updateStatus(id: string, status: SubscriptionStatus, now: string): void {
    this.db.run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
  }

  markCanceled(id: string, now: string): void {
    this.db.run('UPDATE subscriptions SET canceled_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
  }

  setFailedAttempts(id: string, attempts: number, now: string): void {
    this.db.run('UPDATE subscriptions SET failed_attempts = ?, updated_at = ? WHERE id = ?', [attempts, now, id]);
  }
}

export class InvoiceRepository {
  constructor(private readonly db: Database) {}

  insert(invoice: {
    subscriptionId: string;
    amountMinor: number;
    currency: string;
    periodSequence: number;
  }, now: string): InvoiceRow {
    const id = newId('inv');
    this.db.run(
      `INSERT INTO invoices
         (id, subscription_id, amount_minor, currency, status, period_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      [id, invoice.subscriptionId, invoice.amountMinor, invoice.currency, invoice.periodSequence, now, now],
    );
    const inserted = this.findById(id);
    if (!inserted) throw new Error(`invoice ${id} vanished immediately after insert`);
    return inserted;
  }

  findById(id: string): InvoiceRow | undefined {
    return this.db.get<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', [id]);
  }

  findBySubscription(subscriptionId: string): InvoiceRow[] {
    return this.db.all<InvoiceRow>(
      'SELECT * FROM invoices WHERE subscription_id = ? ORDER BY period_sequence',
      [subscriptionId],
    );
  }

  updateStatus(id: string, status: InvoiceStatus, now: string): void {
    this.db.run('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
  }

  /**
   * The invoice a retry should settle: the most recent one still owed. Returning
   * it rather than opening a new invoice is what keeps a `past_due` retry from
   * silently creating a second charge for the same billing period.
   */
  findLatestUnpaid(subscriptionId: string): InvoiceRow | undefined {
    return this.db.get<InvoiceRow>(
      `SELECT * FROM invoices
        WHERE subscription_id = ? AND status IN ('open', 'failed')
        ORDER BY period_sequence DESC LIMIT 1`,
      [subscriptionId],
    );
  }

  /** Cancellation stops future billing, so anything still open is voided. */
  voidOpen(subscriptionId: string, now: string): void {
    this.db.run(
      "UPDATE invoices SET status = 'void', updated_at = ? WHERE subscription_id = ? AND status = 'open'",
      [now, subscriptionId],
    );
  }

  nextPeriodSequence(subscriptionId: string): number {
    return this.db.count(
      'SELECT COALESCE(MAX(period_sequence), 0) + 1 FROM invoices WHERE subscription_id = ?',
      [subscriptionId],
    );
  }
}

export class PaymentRepository {
  constructor(private readonly db: Database) {}

  insert(payment: {
    invoiceId: string;
    subscriptionId: string;
    providerReference: string | null;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
    status: PaymentStatus;
    failureReason: string | null;
  }, now: string): PaymentRow {
    const id = newId('pay');
    this.db.run(
      `INSERT INTO payments
         (id, invoice_id, subscription_id, provider_reference, idempotency_key,
          amount_minor, currency, status, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        payment.invoiceId,
        payment.subscriptionId,
        payment.providerReference,
        payment.idempotencyKey,
        payment.amountMinor,
        payment.currency,
        payment.status,
        payment.failureReason,
        now,
      ],
    );
    const inserted = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [id]);
    if (!inserted) throw new Error(`payment ${id} vanished immediately after insert`);
    return inserted;
  }

  findBySubscription(subscriptionId: string): PaymentRow[] {
    return this.db.all<PaymentRow>(
      'SELECT * FROM payments WHERE subscription_id = ? ORDER BY created_at, id',
      [subscriptionId],
    );
  }

  findByInvoice(invoiceId: string): PaymentRow[] {
    return this.db.all<PaymentRow>(
      'SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at, id',
      [invoiceId],
    );
  }
}

export class AuditLogRepository {
  constructor(private readonly db: Database) {}

  append(entry: {
    subscriptionId: string;
    fromStatus: SubscriptionStatus | null;
    toStatus: SubscriptionStatus;
    trigger: string;
    sourceEventId: string | null;
  }, now: string): void {
    this.db.run(
      `INSERT INTO subscription_events
         (subscription_id, from_status, to_status, trigger, source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.subscriptionId, entry.fromStatus, entry.toStatus, entry.trigger, entry.sourceEventId, now],
    );
  }

  findBySubscription(subscriptionId: string): SubscriptionEventRow[] {
    return this.db.all<SubscriptionEventRow>(
      'SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY id',
      [subscriptionId],
    );
  }
}
