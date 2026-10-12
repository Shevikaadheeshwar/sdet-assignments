/**
 * Plan configuration, held in one place.
 *
 * Price and trial length are read from here at creation *and* at every later
 * billing attempt, which is what makes invariant I6 (plan rules applied
 * consistently) something the design enforces rather than something tests hope
 * for. Deliberately a configuration lookup, not a Strategy pattern — calling it
 * one would be the over-claiming the assignment warns about.
 */
export interface PlanConfig {
  readonly id: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly trialDays: number;
  /** Failed charge attempts tolerated in past_due before retries are exhausted. */
  readonly maxFailedAttempts: number;
}

const PLANS: Readonly<Record<string, PlanConfig>> = Object.freeze({
  basic: { id: 'basic', priceMinor: 1900, currency: 'USD', trialDays: 14, maxFailedAttempts: 3 },
  pro: { id: 'pro', priceMinor: 4900, currency: 'USD', trialDays: 0, maxFailedAttempts: 3 },
});

export class PlanCatalog {
  get(planId: unknown): PlanConfig | undefined {
    if (typeof planId !== 'string') return undefined;
    return PLANS[planId];
  }

  ids(): string[] {
    return Object.keys(PLANS);
  }
}
