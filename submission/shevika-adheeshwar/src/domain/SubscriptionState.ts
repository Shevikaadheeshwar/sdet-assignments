/**
 * The subscription lifecycle states, exactly as specified in SDET_ASSIGNMENT.md.
 *
 * Declared `as const` so the union type is derived from the runtime list rather
 * than duplicated beside it: adding a state in one place without the other is a
 * compile error, not a silent divergence between code and database CHECK
 * constraint.
 */
export const SUBSCRIPTION_STATES = ['trialing', 'active', 'past_due', 'canceled'] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATES as readonly string[]).includes(value);
}
