# Subscription & Billing Service — SDET Submission

Automated validation suite for a Subscription & Billing Service, with a minimal
service fixture to validate against (**Option 2** in `SDET_ASSIGNMENT.md` — the
repository ships a specification only, no implementation).

> **Status: scaffold.** The test strategy is written and the toolchain is verified.
> The service fixture and test suite are being built incrementally against
> [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md), which is the authoritative
> design document for this submission and was committed *before* the code.

## Requirements

- **Node.js >= 18.18.0** (CI runs Node 18; verified locally on 18.18.0)
- No native toolchain, compiler, Python, or database server required

SQLite is used via **`sql.js`**, a WebAssembly build. That is a deliberate choice:
a reviewer must be able to clone this and run it on an unknown machine, and a
native module (`better-sqlite3`) needs a prebuild matching their exact Node ABI
and platform, or a working `node-gyp` toolchain. The WASM build installs
identically everywhere while still being *real* SQLite — real `UNIQUE`, `CHECK`
and `FOREIGN KEY` enforcement and real transactions, which is what the
idempotency guarantees in §9 of the strategy document rest on.

## Setup

```bash
cd submission/shevika-adheeshwar
npm ci          # or: npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run validate:schema` | Applies `schema.sql` to a fresh database and exercises every constraint the suite depends on |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Full Vitest suite |
| `npm run test:reliability` | Idempotency / out-of-order / concurrency tests only |
| `npm run verify` | All of the above, in order |

## Layout

```
docs/TEST_STRATEGY.md      design document — assumptions, scope, invariants, patterns
scripts/validate_schema.js schema + constraint validation (plain JS, no build step)
src/                       the service fixture (system under test)
  persistence/schema.sql   subscriptions, invoices, payments, webhook_events, audit
tests/                     the validation suite — the actual deliverable
```

## Why `validate_schema.js` does more than print a message

Two constraints carry the system's correctness guarantees:

- `webhook_events.event_id PRIMARY KEY` — a replayed webhook cannot be applied twice
- `payments.idempotency_key UNIQUE` — a billing attempt cannot be charged twice

If either were dropped, the idempotency tests would still pass, for the wrong
reason. So the validator inserts a duplicate and **asserts the database refuses
it**. Removing the `PRIMARY KEY` from `webhook_events` makes this script fail with
exit code 1 — verified, not assumed.
