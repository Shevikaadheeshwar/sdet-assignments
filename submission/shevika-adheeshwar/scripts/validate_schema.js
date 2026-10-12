#!/usr/bin/env node
/**
 * Schema / setup validation.
 *
 * Deliberately plain JavaScript with no build step, so the repository's CI workflow
 * can run `node scripts/validate_schema.js` verbatim on Node 18. The project is ESM
 * (`"type": "module"`), so this file is ESM too and keeps that exact filename.
 *
 * This does not merely print "schema valid". It applies schema.sql to a fresh
 * in-memory database and then *exercises* the constraints the test suite relies
 * on, so that a schema change which quietly drops one of them fails here rather
 * than turning an idempotency test green for the wrong reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, '..', 'src', 'persistence', 'schema.sql');

const EXPECTED_TABLES = [
  'customers',
  'subscriptions',
  'invoices',
  'payments',
  'webhook_events',
  'subscription_events',
];

const NOW = '2026-01-01T00:00:00.000Z';

const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Asserts that `fn` fails with the specific SQLite constraint we care about.
 * Matching the constraint kind rather than "it threw" is the point: a typo in a
 * table name would otherwise satisfy a looser assertion.
 */
function assertViolates(fn, expectedFragment, message) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, message + ' (no error was raised)');
  assert(
    threw.message.includes(expectedFragment),
    message + ' (expected "' + expectedFragment + '", got "' + threw.message + '")',
  );
}

function scalar(db, sql) {
  const result = db.exec(sql);
  return result[0].values[0][0];
}

function seedSubscription(db) {
  db.run("INSERT INTO customers VALUES ('cust_1', 'a@b.test', 'pm_1', ?)", [NOW]);
  db.run(
    'INSERT INTO subscriptions (id, customer_id, plan, status, payment_method_id,' +
      ' amount_minor, currency, trial_days, failed_attempts, created_at, updated_at)' +
      " VALUES ('sub_1', 'cust_1', 'pro', 'trialing', 'pm_1', 4900, 'USD', 0, 0, ?, ?)",
    [NOW, NOW],
  );
  db.run(
    'INSERT INTO invoices (id, subscription_id, amount_minor, currency, status,' +
      " period_sequence, created_at, updated_at) VALUES ('inv_1', 'sub_1', 4900, 'USD', 'open', 1, ?, ?)",
    [NOW, NOW],
  );
}

async function main() {
  assert(fs.existsSync(SCHEMA_PATH), 'schema.sql not found at ' + SCHEMA_PATH);
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  assert(schema.trim().length > 0, 'schema.sql is empty');

  const SQL = await initSqlJs();
  const db = new SQL.Database();

  check('schema applies cleanly to a fresh database', () => {
    db.run(schema);
    db.run('PRAGMA foreign_keys = ON');
  });

  check('all expected tables exist', () => {
    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const names = result[0].values.map((row) => row[0]);
    for (const table of EXPECTED_TABLES) {
      assert(names.includes(table), 'missing table: ' + table);
    }
  });

  check('webhook_events.event_id rejects duplicate delivery (invariant I3)', () => {
    const insert =
      "INSERT INTO webhook_events VALUES ('evt_dup', 'payment.succeeded', 'sub_1'," +
      " 'inv_1', '{}', 'applied', '" + NOW + "')";
    db.run(insert);
    assertViolates(
      () => db.run(insert),
      'UNIQUE constraint failed',
      'a replayed event_id was accepted',
    );
    const count = scalar(db, 'SELECT COUNT(*) FROM webhook_events');
    assert(count === 1, 'expected exactly 1 webhook_events row, found ' + count);
  });

  check('payments.idempotency_key rejects a duplicate charge (invariant I4)', () => {
    seedSubscription(db);
    const insert = (id, ref) =>
      db.run(
        'INSERT INTO payments (id, invoice_id, subscription_id, provider_reference,' +
          ' idempotency_key, amount_minor, currency, status, failure_reason, created_at)' +
          " VALUES ('" + id + "', 'inv_1', 'sub_1', '" + ref + "', 'idem_1', 4900, 'USD'," +
          " 'succeeded', NULL, '" + NOW + "')",
      );
    insert('pay_1', 'ref_1');
    assertViolates(
      () => insert('pay_2', 'ref_2'),
      'UNIQUE constraint failed',
      'a duplicate idempotency_key was accepted',
    );
  });

  check('subscriptions.status rejects a status outside the lifecycle', () => {
    assertViolates(
      () =>
        db.run(
          'INSERT INTO subscriptions (id, customer_id, plan, status, payment_method_id,' +
            ' amount_minor, currency, trial_days, failed_attempts, created_at, updated_at)' +
            " VALUES ('sub_bad', 'cust_1', 'pro', 'paused', 'pm_1', 4900, 'USD', 0, 0," +
            " '" + NOW + "', '" + NOW + "')",
        ),
      'CHECK constraint failed',
      'an unknown subscription status was accepted',
    );
  });

  check('invoices enforce one invoice per billing period', () => {
    assertViolates(
      () =>
        db.run(
          'INSERT INTO invoices (id, subscription_id, amount_minor, currency, status,' +
            " period_sequence, created_at, updated_at) VALUES ('inv_dup', 'sub_1', 4900," +
            " 'USD', 'open', 1, '" + NOW + "', '" + NOW + "')",
        ),
      'UNIQUE constraint failed',
      'a second invoice for the same billing period was accepted',
    );
  });

  check('foreign keys are enforced', () => {
    assertViolates(
      () =>
        db.run(
          'INSERT INTO invoices (id, subscription_id, amount_minor, currency, status,' +
            " period_sequence, created_at, updated_at) VALUES ('inv_orphan', 'sub_missing'," +
            " 4900, 'USD', 'open', 9, '" + NOW + "', '" + NOW + "')",
        ),
      'FOREIGN KEY constraint failed',
      'an invoice referencing an unknown subscription was accepted',
    );
  });

  db.close();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.ok ? '' : '\n        ' + c.error));
  }
  console.log(
    '\n' + (checks.length - failed.length) + '/' + checks.length + ' schema checks passed',
  );

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('schema validation crashed: ' + err.stack);
  process.exit(1);
});
