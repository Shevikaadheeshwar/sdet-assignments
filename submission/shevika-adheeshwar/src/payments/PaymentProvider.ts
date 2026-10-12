/**
 * The seam around the external payment provider.
 *
 * This interface is the only thing the service knows about charging money, so a
 * test double substitutes for it with no network, no HTTP interception and no
 * module patching. It is injected at the composition root (`createApp`).
 *
 * Declines and timeouts are returned as outcomes rather than thrown, because
 * they are ordinary business results that the lifecycle has defined handling
 * for. Reserving exceptions for genuine faults keeps `catch` blocks honest.
 */
export interface ChargeRequest {
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Stable per billing attempt, so a provider-side retry cannot double-charge. */
  readonly idempotencyKey: string;
  /** The invoice this charge settles. */
  readonly reference: string;
}

export type ChargeOutcome =
  | { readonly status: 'succeeded'; readonly providerReference: string }
  | { readonly status: 'declined'; readonly declineCode: string; readonly message: string }
  | { readonly status: 'timed_out'; readonly message: string };

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}
