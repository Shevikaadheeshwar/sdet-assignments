-- Subscription & Billing Service — test fixture schema.
--
-- Two constraints below are load-bearing rather than decorative, and are the
-- reason this fixture uses a real embedded database instead of an in-memory Map:
--
--   * webhook_events.event_id PRIMARY KEY  -> webhook idempotency (invariant I3)
--   * payments.idempotency_key UNIQUE      -> at most one charge per attempt (I4)
--
-- Both make duplicate side effects impossible at the storage layer, so the tests
-- prove a guarantee rather than the current shape of an if-statement.

PRAGMA foreign_keys = ON;

CREATE TABLE customers (
  id                        TEXT PRIMARY KEY,
  email                     TEXT NOT NULL,
  default_payment_method_id TEXT,
  created_at                TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  plan              TEXT NOT NULL,
  status            TEXT NOT NULL
                      CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  payment_method_id TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  trial_days        INTEGER NOT NULL CHECK (trial_days >= 0),
  failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  canceled_at       TEXT
);

-- What is owed for one billing period.
CREATE TABLE invoices (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL REFERENCES subscriptions(id),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL
                     CHECK (status IN ('open', 'paid', 'failed', 'refunded', 'void')),
  period_sequence  INTEGER NOT NULL CHECK (period_sequence >= 1),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (subscription_id, period_sequence)
);

-- One attempt to settle an invoice. Separate from invoices so that three failed
-- attempts against a single period are expressible, and so a duplicate charge
-- shows up as a constraint violation rather than an extra indistinguishable row.
CREATE TABLE payments (
  id                 TEXT PRIMARY KEY,
  invoice_id         TEXT NOT NULL REFERENCES invoices(id),
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id),
  provider_reference TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  amount_minor       INTEGER NOT NULL CHECK (amount_minor > 0),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL
                       CHECK (status IN ('succeeded', 'failed', 'timed_out', 'refunded')),
  failure_reason     TEXT,
  created_at         TEXT NOT NULL
);

-- Every inbound webhook, including ones deliberately not acted upon. Recording an
-- ignored event is the point: "received and declined to apply" is auditable,
-- silently dropping it is not.
CREATE TABLE webhook_events (
  event_id        TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  subscription_id TEXT,
  invoice_id      TEXT,
  payload         TEXT NOT NULL,
  outcome         TEXT NOT NULL
                    CHECK (outcome IN ('applied', 'ignored_stale', 'ignored_terminal')),
  received_at     TEXT NOT NULL
);

-- Append-only audit trail of lifecycle changes, per subscription.
CREATE TABLE subscription_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  source_event_id TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_subscriptions_customer    ON subscriptions (customer_id);
CREATE INDEX idx_invoices_subscription     ON invoices (subscription_id);
CREATE INDEX idx_payments_invoice          ON payments (invoice_id);
CREATE INDEX idx_payments_subscription     ON payments (subscription_id);
CREATE INDEX idx_webhook_events_sub        ON webhook_events (subscription_id);
CREATE INDEX idx_sub_events_subscription   ON subscription_events (subscription_id);
