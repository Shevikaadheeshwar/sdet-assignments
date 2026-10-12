import type { SubscriptionStatus } from './SubscriptionState';

/**
 * The lifecycle triggers. Four triggers produce the specification's seven edges,
 * because several states respond to the same event differently — which is the
 * point of a transition table rather than a chain of conditionals.
 */
export const LIFECYCLE_TRIGGERS = [
  'payment.succeeded',
  'payment.failed',
  'retries.exhausted',
  'cancel.requested',
] as const;

export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

export interface TransitionDefinition {
  readonly from: SubscriptionStatus;
  readonly trigger: LifecycleTrigger;
  readonly to: SubscriptionStatus;
  /** The wording from the assignment's lifecycle diagram, kept verbatim. */
  readonly description: string;
}

/**
 * The lifecycle, transcribed from SDET_ASSIGNMENT.md one line at a time.
 *
 * `canceled` appears only ever as a destination. It has no outgoing edges, so
 * "a stray webhook reactivates a canceled subscription" is not a bug that is
 * guarded against — it is a move with nowhere to go. That is the difference
 * between a state machine and a status string.
 */
const TRANSITIONS: readonly TransitionDefinition[] = Object.freeze([
  {
    from: 'trialing',
    trigger: 'payment.succeeded',
    to: 'active',
    description: 'trial ends, first charge succeeds',
  },
  {
    from: 'trialing',
    trigger: 'payment.failed',
    to: 'past_due',
    description: 'trial ends, first charge fails',
  },
  {
    from: 'active',
    trigger: 'payment.failed',
    to: 'past_due',
    description: 'recurring charge fails',
  },
  {
    from: 'past_due',
    trigger: 'payment.succeeded',
    to: 'active',
    description: 'retry charge succeeds',
  },
  {
    from: 'past_due',
    trigger: 'retries.exhausted',
    to: 'canceled',
    description: 'retries exhausted',
  },
  {
    from: 'active',
    trigger: 'cancel.requested',
    to: 'canceled',
    description: 'customer/API cancel',
  },
  {
    from: 'trialing',
    trigger: 'cancel.requested',
    to: 'canceled',
    description: 'customer/API cancel',
  },
]);

/**
 * Answers one question — "where does this state go on this trigger?" — and
 * nothing else.
 *
 * It deliberately does not decide what an impossible move *means*. An API caller
 * asking for one is an error (409); a payment provider redelivering a stale
 * webhook is not, and should be recorded and ignored. Keeping that policy with
 * the caller lets the same table serve both without knowing about HTTP.
 */
export class TransitionTable {
  next(from: SubscriptionStatus, trigger: LifecycleTrigger): SubscriptionStatus | undefined {
    return TRANSITIONS.find(
      (transition) => transition.from === from && transition.trigger === trigger,
    )?.to;
  }

  isTerminal(state: SubscriptionStatus): boolean {
    return !TRANSITIONS.some((transition) => transition.from === state);
  }

  all(): readonly TransitionDefinition[] {
    return TRANSITIONS;
  }

  triggers(): readonly LifecycleTrigger[] {
    return LIFECYCLE_TRIGGERS;
  }
}
