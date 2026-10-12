import { randomUUID } from 'node:crypto';

/** Prefixed identifiers (`sub_`, `inv_`, `pay_`) matching the assignment's examples. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
