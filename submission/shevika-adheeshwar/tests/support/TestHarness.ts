import type { Express } from 'express';

import { createApp } from '../../src/http/createApp';
import { Database } from '../../src/persistence/Database';
import { CustomerRepository } from '../../src/persistence/repositories';
import type { Clock } from '../../src/support/clock';

import { ApiClient } from './ApiClient';
import { DbVerifier } from './DbVerifier';
import { MockPaymentProvider } from './MockPaymentProvider';
import { WebhookSimulator } from './WebhookSimulator';

export interface SeedCustomer {
  readonly id: string;
  readonly paymentMethodId?: string | null;
  readonly email?: string;
}

/**
 * The test fixture: one isolated system under test per use.
 *
 * Each harness owns a fresh in-memory database built from schema.sql, its own
 * mock provider, and its own app instance. Nothing is shared between tests, so
 * stale data cannot produce a false positive and tests cannot depend on
 * execution order — the cheapest form of isolation available, and the reason
 * there is no truncation or cleanup logic anywhere in this suite.
 *
 * Time is injected (A2.2): the clock advances only when a test says so.
 */
export const TEST_WEBHOOK_SECRET = 'whsec_test_secret';

export class TestHarness {
  readonly api: ApiClient;
  readonly db: DbVerifier;
  readonly webhooks: WebhookSimulator;

  private constructor(
    readonly app: Express,
    readonly provider: MockPaymentProvider,
    private readonly database: Database,
    private readonly customers: CustomerRepository,
    private readonly tick: () => string,
  ) {
    this.api = new ApiClient(app);
    this.db = new DbVerifier(database);
    this.webhooks = new WebhookSimulator(this.api, TEST_WEBHOOK_SECRET);
  }

  static async start(): Promise<TestHarness> {
    const database = await Database.create();
    const provider = new MockPaymentProvider();

    // A deterministic clock: every call advances one second from a fixed epoch,
    // so timestamps are ordered and reproducible without touching the real time.
    let ticks = 0;
    const tick = (): string => new Date(Date.UTC(2026, 0, 1) + ticks++ * 1000).toISOString();
    const clock: Clock = () => tick();

    const app = createApp({
      database,
      paymentProvider: provider,
      clock,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    return new TestHarness(app, provider, database, new CustomerRepository(database), tick);
  }

  /** Seeds a customer directly, since the service exposes no customer endpoint. */
  seedCustomer(customer: SeedCustomer): void {
    this.customers.insert(
      {
        id: customer.id,
        email: customer.email ?? `${customer.id}@example.test`,
        paymentMethodId: customer.paymentMethodId ?? null,
      },
      this.tick(),
    );
  }

  /**
   * Writes straight to the database, bypassing the service.
   *
   * Only for proving that a verification helper actually detects a broken
   * invariant. Production code paths must never reach for this, which is why it
   * is named to be uncomfortable to use by accident.
   */
  corruptForTesting(sql: string): void {
    this.database.run(sql);
  }

  stop(): void {
    this.database.close();
  }
}
