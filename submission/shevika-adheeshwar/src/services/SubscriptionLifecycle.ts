import type { LifecycleTrigger, TransitionTable } from '../domain/TransitionTable';
import type { AuditLogRepository, SubscriptionRepository } from '../persistence/repositories';
import type { SubscriptionRow } from '../persistence/rows';
import type { Clock } from '../support/clock';

export interface ApplyOptions {
  /** The webhook event that caused this change, when there was one. */
  readonly sourceEventId?: string | null;
  /** Overrides the audit trigger label when the lifecycle trigger is too coarse. */
  readonly auditTrigger?: string;
}

/**
 * The single point at which a subscription's status may change.
 *
 * Every status write in the codebase goes through here, so a transition cannot
 * be smuggled in from a new call site: there is no other method that updates the
 * column. Each applied transition also writes its audit row in the same step,
 * which is what keeps the audit trail complete by construction rather than by
 * everyone remembering to log.
 *
 * Returns `undefined` when the table has no edge for the move. The caller
 * decides whether that is an error or a no-op.
 */
export class SubscriptionLifecycle {
  constructor(
    private readonly table: TransitionTable,
    private readonly subscriptions: SubscriptionRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: Clock,
  ) {}

  apply(
    subscription: SubscriptionRow,
    trigger: LifecycleTrigger,
    options: ApplyOptions = {},
  ): SubscriptionRow | undefined {
    const to = this.table.next(subscription.status, trigger);
    if (!to) return undefined;

    const now = this.clock();
    this.subscriptions.updateStatus(subscription.id, to, now);
    if (to === 'canceled') {
      this.subscriptions.markCanceled(subscription.id, now);
    }

    this.audit.append(
      {
        subscriptionId: subscription.id,
        fromStatus: subscription.status,
        toStatus: to,
        trigger: options.auditTrigger ?? trigger,
        sourceEventId: options.sourceEventId ?? null,
      },
      now,
    );

    const updated = this.subscriptions.findById(subscription.id);
    if (!updated) throw new Error(`subscription ${subscription.id} vanished mid-transition`);
    return updated;
  }

  isTerminal(subscription: SubscriptionRow): boolean {
    return this.table.isTerminal(subscription.status);
  }
}
