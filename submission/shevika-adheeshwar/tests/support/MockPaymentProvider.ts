import type { ChargeOutcome, ChargeRequest, PaymentProvider } from '../../src/payments/PaymentProvider';

/**
 * The test double for the external payment provider.
 *
 * Hand-written rather than `vi.fn()` on purpose. The scenarios need a provider
 * whose outcome can be scripted per attempt ("decline the first charge, succeed
 * on the retry"), and a call log that reads as domain data in assertions. A
 * mock function would express both less clearly.
 *
 * It records every call so tests can assert on *arguments*, not just that
 * something happened.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly charges: ChargeRequest[] = [];

  private queue: ChargeOutcome[] = [];
  private fallback: ChargeOutcome = {
    status: 'succeeded',
    providerReference: 'ref_default',
  };

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    return this.queue.shift() ?? this.fallback;
  }

  get chargeCount(): number {
    return this.charges.length;
  }

  /** Every charge from now on succeeds. */
  willSucceed(providerReference = 'ref_test_1'): this {
    this.fallback = { status: 'succeeded', providerReference };
    return this;
  }

  /** Every charge from now on is declined. */
  willDecline(declineCode = 'card_declined'): this {
    this.fallback = { status: 'declined', declineCode, message: `Card ${declineCode}` };
    return this;
  }

  /** Every charge from now on times out. */
  willTimeout(): this {
    this.fallback = { status: 'timed_out', message: 'Provider did not respond in time' };
    return this;
  }

  /** Scripts the next charges in order, before falling back to the standing outcome. */
  willRespondWith(...outcomes: ChargeOutcome[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  reset(): void {
    this.charges.length = 0;
    this.queue = [];
  }
}
