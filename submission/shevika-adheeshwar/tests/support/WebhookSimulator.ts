import { createHmac } from 'node:crypto';

import type { ApiClient, ApiError, ApiResponse } from './ApiClient';

export const WEBHOOK_PATH = '/webhooks/payment-provider';

export interface WebhookResult {
  status: string;
  [key: string]: unknown;
}

/**
 * Stands in for the payment provider's outbound webhook delivery.
 *
 * The suite constructs and signs payloads itself, which is what lets it deliver
 * the cases a real provider never would: a forged signature, a body altered
 * after signing, a replayed event. Signing here with the same algorithm the
 * service verifies with is deliberate — a test that asked the service to sign
 * its own input would prove nothing.
 */
export class WebhookSimulator {
  constructor(
    private readonly api: ApiClient,
    private readonly secret: string,
  ) {}

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  /** Delivers a correctly signed payload, as the provider would. */
  async deliver(payload: Record<string, unknown>): Promise<ApiResponse<WebhookResult & ApiError>> {
    const rawBody = JSON.stringify(payload);
    return this.api.postRaw(WEBHOOK_PATH, rawBody, {
      'X-Provider-Signature': this.sign(rawBody),
    }) as Promise<ApiResponse<WebhookResult & ApiError>>;
  }

  /** Delivers with no signature header at all. */
  async deliverUnsigned(
    payload: Record<string, unknown>,
  ): Promise<ApiResponse<WebhookResult & ApiError>> {
    return this.api.postRaw(WEBHOOK_PATH, JSON.stringify(payload)) as Promise<
      ApiResponse<WebhookResult & ApiError>
    >;
  }

  /** Delivers with a signature that does not match the body. */
  async deliverWithSignature(
    payload: Record<string, unknown>,
    signature: string,
  ): Promise<ApiResponse<WebhookResult & ApiError>> {
    return this.api.postRaw(WEBHOOK_PATH, JSON.stringify(payload), {
      'X-Provider-Signature': signature,
    }) as Promise<ApiResponse<WebhookResult & ApiError>>;
  }

  /** Delivers an exact byte sequence, for payloads that are not valid JSON. */
  async deliverRaw(
    rawBody: string,
    options: { signature?: string } = {},
  ): Promise<ApiResponse<WebhookResult & ApiError>> {
    const headers =
      options.signature === undefined ? {} : { 'X-Provider-Signature': options.signature };
    return this.api.postRaw(WEBHOOK_PATH, rawBody, headers) as Promise<
      ApiResponse<WebhookResult & ApiError>
    >;
  }
}
