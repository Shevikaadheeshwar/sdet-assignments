import type { SubscriptionRow } from '../persistence/rows';

/**
 * The public shape of a subscription. Written explicitly rather than returning
 * the database row, so that adding an internal column cannot silently widen the
 * API contract.
 */
export interface SubscriptionResource {
  id: string;
  customer_id: string;
  plan: string;
  status: string;
  payment_method_id: string;
  amount_minor: number;
  currency: string;
  trial_days: number;
  created_at: string;
  updated_at: string;
  canceled_at: string | null;
}

export function toSubscriptionResource(row: SubscriptionRow): SubscriptionResource {
  return {
    id: row.id,
    customer_id: row.customer_id,
    plan: row.plan,
    status: row.status,
    payment_method_id: row.payment_method_id,
    amount_minor: row.amount_minor,
    currency: row.currency,
    trial_days: row.trial_days,
    created_at: row.created_at,
    updated_at: row.updated_at,
    canceled_at: row.canceled_at,
  };
}
