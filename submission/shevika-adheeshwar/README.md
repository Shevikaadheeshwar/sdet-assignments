# Subscription & Billing Service — SDET Submission

An automated validation suite for a Subscription & Billing Service, plus the
minimal service fixture it validates.

The repository ships a specification only — no implementation — so this is
**Option 2** from `SDET_ASSIGNMENT.md`: build a small fixture, then build the
suite that is the actual deliverable. The code under `src/` exists to be tested.
The code under `tests/` is the submission.

The design document, written and committed **before** any code, is
[`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md). It holds the assumptions,
scope, invariants and limitations, and is the thing this implementation is held
to. The PR description is [`docs/PR_DESCRIPTION.md`](docs/PR_DESCRIPTION.md).

## Requirements

- **Node.js >= 18.18.0** — verified on 18.18.0, the version the repository's CI pins
- No compiler, no Python, no database server, no `node-gyp`

SQLite comes from **`sql.js`**, a WebAssembly build. That is deliberate. A
reviewer has to run this on a machine I know nothing about, and the native
module (`better-sqlite3`) needs either a prebuild matching their exact Node ABI
and platform or a working `node-gyp` toolchain — it failed to build here on Node
18 during development. The WASM build installs identically everywhere and is
still *real* SQLite: real `UNIQUE`, `CHECK` and `FOREIGN KEY` enforcement and
real transactions, which is what the idempotency guarantees rest on.

## Setup and run

```bash
cd submission/shevika-adheeshwar
npm ci
npm run verify
```

`npm run verify` runs lint, type check, schema validation and the full suite in
that order. Expect roughly 2 seconds to install and 2 seconds to run.

| Command | What it does |
|---|---|
| `npm test` | Full Vitest suite — 75 tests |
| `npm run test:reliability` | Idempotency and out-of-order tests — 14 tests |
| `npm run validate:schema` | Applies `schema.sql` and exercises every constraint — 7 checks |
| `npm run lint` | ESLint, flat config |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | All of the above |

### Verified from a clean setup

```
rm -rf node_modules && npm ci   ->  271 packages in 2s
npm run verify                  ->  lint clean, typecheck clean,
                                    7/7 schema checks, 75/75 tests
```

## Layout

```
docs/TEST_STRATEGY.md        design document, committed before the code
docs/PR_DESCRIPTION.md       the filled-in submission template
scripts/validate_schema.js   schema + constraint validation, no build step

src/                         the fixture — the system under test
  domain/
    TransitionTable.ts       the lifecycle, transcribed from the diagram
    SubscriptionState.ts     the four states
    PlanCatalog.ts           price, trial length, retry limit per plan
    WebhookEvent.ts          parsing and shape rules for inbound events
    errors.ts                DomainError — carries an HTTP status, imports no Express
  payments/
    PaymentProvider.ts       the seam: the interface tests substitute
  persistence/
    schema.sql               six tables, two load-bearing constraints
    Database.ts              SQLite wrapper, transactions
    repositories.ts          the only place SQL is written
    rows.ts                  row types
  services/
    SubscriptionLifecycle.ts the only code that writes the status column
    BillingService.ts        one billing attempt: invoice, charge, record
    SubscriptionService.ts   create / read / cancel / bill
    WebhookProcessor.ts      apply an inbound event exactly once
  http/
    createApp.ts             composition root — where the provider is injected
    signature.ts             HMAC over the raw body, timing-safe comparison
    resources.ts             the public response shape

tests/                       the deliverable
  support/
    TestHarness.ts           isolated database + mock provider + app, per test
    ApiClient.ts             typed client; keeps transport out of scenarios
    MockPaymentProvider.ts   records arguments, scriptable per attempt
    WebhookSimulator.ts      signs, forges and corrupts webhook deliveries
    DbVerifier.ts            persistence assertions, including the invariant sweep
    scenarios.ts             named starting positions, reached through the real API
    builders/                subscription requests and webhook payloads
  api/                       contract, validation, webhook transport    (27 tests)
  lifecycle/                 seven valid transitions, invalid ones       (14 tests)
  provider/                  call count, arguments, decline, timeout     (12 tests)
  reliability/               idempotency, out-of-order, terminal         (14 tests)
  persistence/               the §8 invariants                            (6 tests)
  e2e/                       one subscription's whole life                (2 tests)
```

## What is real and what is mocked

| | |
|---|---|
| **Real** | The service, the HTTP layer, HMAC verification, SQLite persistence with live constraints and transactions, the transition table, the repositories |
| **Mocked** | **The payment provider, and nothing else** — an interface implementation injected at the composition root, with scriptable success / decline / timeout outcomes and a recorded call log |
| **Simulated** | Inbound webhooks, constructed and signed by the suite, including deliberately forged, tampered and malformed variants |

Nothing makes an outbound HTTP call, so there is no `nock` or `msw`: they would
intercept traffic that does not exist.

## The two ideas worth knowing before reading the code

**The lifecycle is a table, and `canceled` has no outgoing edges.** Reactivating
a canceled subscription is not a bug that is guarded against — it is a move with
nowhere to go. `SubscriptionLifecycle` is the only code in the repository that
writes the status column, and it writes the audit row in the same step.

**Idempotency is a database guarantee.** `webhook_events.event_id` is a
`PRIMARY KEY`, and the event row is inserted *first*, inside the same
transaction as its effects. A redelivery fails that insert and the transaction
rolls back, so nothing downstream ever ran. An `if (alreadySeen)` check can be
bypassed by a future call site and is a race under concurrency; a constraint is
neither.

## How the suite is checked against itself

Passing tests prove nothing on their own — a test asserting the wrong thing
passes just as happily. Every phase therefore deliberately broke the
implementation and recorded which tests noticed. **19 mutations, 17 caught, 2
documented as surviving.** The full table is in `TEST_STRATEGY.md §12a`, and the
two survivors are written up as real gaps in §11 rather than quietly dropped.

## Known limitations

Summarised here, in full in `TEST_STRATEGY.md §11`:

- Billing is call-driven, not time-driven — `POST /subscriptions/{id}/bill`
  stands in for a scheduler so tests never sleep
- `sql.js` is synchronous and single-process, so **concurrent** webhook delivery
  cannot be exercised; the concurrency bonus is not attempted, because a test
  that cannot fail is worse than no test
- The timing-safe signature comparison is not covered by any test
- No contract test against a real provider SDK
