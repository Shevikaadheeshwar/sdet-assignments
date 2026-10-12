import type { SubscriptionStatus } from '../domain/SubscriptionState';

export interface CustomerRow {
  id: string;
  email: string;
  default_payment_method_id: string | null;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  customer_id: string;
  plan: string;
  status: SubscriptionStatus;
  payment_method_id: string;
  amount_minor: number;
  currency: string;
  trial_days: number;
  failed_attempts: number;
  created_at: string;
  updated_at: string;
  canceled_at: string | null;
}

export type InvoiceStatus = 'open' | 'paid' | 'failed' | 'refunded' | 'void';

export interface InvoiceRow {
  id: string;
  subscription_id: string;
  amount_minor: number;
  currency: string;
  status: InvoiceStatus;
  period_sequence: number;
  created_at: string;
  updated_at: string;
}

export type PaymentStatus = 'succeeded' | 'failed' | 'timed_out' | 'refunded';

export interface PaymentRow {
  id: string;
  invoice_id: string;
  subscription_id: string;
  provider_reference: string | null;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  failure_reason: string | null;
  created_at: string;
}

export interface SubscriptionEventRow {
  id: number;
  subscription_id: string;
  from_status: SubscriptionStatus | null;
  to_status: SubscriptionStatus;
  trigger: string;
  source_event_id: string | null;
  created_at: string;
}
