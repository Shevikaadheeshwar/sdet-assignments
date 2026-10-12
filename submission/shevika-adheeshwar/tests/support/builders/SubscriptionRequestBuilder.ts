/**
 * Builder for subscription creation payloads.
 *
 * Scenarios differ by one field at a time — a different plan, a missing customer,
 * an absent payment method. Without a builder every test would restate the whole
 * literal and the meaningful difference would be buried. Here a test names only
 * what it is actually about, and defaults supply the rest.
 *
 * `omitting()` exists so validation tests can remove a required field without
 * resorting to `as any`.
 */
export class SubscriptionRequestBuilder {
  private payload: Record<string, unknown> = {
    customer_id: 'cust_001',
    plan: 'pro',
    payment_method_id: 'pm_test_visa_4242',
  };

  forCustomer(customerId: string): this {
    this.payload['customer_id'] = customerId;
    return this;
  }

  onPlan(plan: string): this {
    this.payload['plan'] = plan;
    return this;
  }

  withPaymentMethod(paymentMethodId: string): this {
    this.payload['payment_method_id'] = paymentMethodId;
    return this;
  }

  omitting(field: 'customer_id' | 'plan' | 'payment_method_id'): this {
    delete this.payload[field];
    return this;
  }

  with(field: string, value: unknown): this {
    this.payload[field] = value;
    return this;
  }

  build(): Record<string, unknown> {
    return { ...this.payload };
  }
}

export function aSubscriptionRequest(): SubscriptionRequestBuilder {
  return new SubscriptionRequestBuilder();
}
