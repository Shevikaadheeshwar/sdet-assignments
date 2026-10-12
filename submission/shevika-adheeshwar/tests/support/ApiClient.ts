import type { Express } from 'express';
import request from 'supertest';

import type { SubscriptionResource } from '../../src/http/resources';

export interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

export interface ApiError {
  error: { code: string; message: string };
}

/**
 * A typed client over the HTTP surface.
 *
 * Tests state intent ("create this subscription") and never mention transport.
 * When a route, header or payload shape changes, it changes here once instead of
 * in every scenario that happens to call it.
 */
export class ApiClient {
  constructor(private readonly app: Express) {}

  async createSubscription(
    payload: Record<string, unknown>,
  ): Promise<ApiResponse<SubscriptionResource & ApiError>> {
    const response = await request(this.app).post('/subscriptions').send(payload);
    return { status: response.status, body: response.body };
  }

  async getSubscription(id: string): Promise<ApiResponse<SubscriptionResource & ApiError>> {
    const response = await request(this.app).get(`/subscriptions/${id}`);
    return { status: response.status, body: response.body };
  }

  /** Posts a body exactly as given, bypassing JSON serialisation. */
  async postRaw(
    path: string,
    rawBody: string,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<ApiError>> {
    const response = await request(this.app)
      .post(path)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(rawBody);
    return { status: response.status, body: response.body };
  }
}
