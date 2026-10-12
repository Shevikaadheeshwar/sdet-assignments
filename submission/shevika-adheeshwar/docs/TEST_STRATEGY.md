# Test Strategy — Subscription & Billing Service

**Status: DRAFT (documentation-first, written before implementation).**
This document is committed ahead of the code on purpose. The assignment asks for a
test strategy to be defined *before* writing large amounts of automation, so this
file is the contract the implementation is then held to. Sections marked
`(to be completed)` are filled in truthfully as the code lands — nothing is claimed
here that is not demonstrably in the repository.

---

## 1. Understanding of the task

The repository ships a **specification only**: `SDET_ASSIGNMENT.md`, a README
describing the submission protocol, and a PR template. There is no service
implementation, no scaffolding, and no existing tests.

Per the *System Under Test Assumptions* section I take **Option 2 — build a minimal
service fixture**. Two things follow from that, and they matter for how this
submission should be read:

- The service under `src/` exists **to be tested**. It is deliberately small, and
  makes no claim to be a product. Where a real billing system would be richer, the
  simplification is recorded in §11 rather than hidden.
- The **deliverable being assessed is the suite under `tests/`** — its coverage
  strategy, its assertions, and its architecture.

The assignment is explicit that this is not a CRUD exercise. The risks worth
automating in a stateful, billed workflow are: illegal lifecycle transitions,
duplicate webhook delivery, out-of-order webhook delivery, provider failure modes,
and persistence drifting out of agreement with the API. The scenario priorities in
§12 are ordered by those risks, not by endpoint.

---

## 2. Assumptions about the system under test

The specification defines the lifecycle precisely but leaves plan configuration,
time handling, and retry limits open. These are the choices this submission makes.
Each is a decision, not an oversight.

| # | Assumption |
|---|---|
| **A2.1** | **Plans.** `basic` = 1900 minor units/month with a 14-day trial. `pro` = 4900 minor units/month (matching the spec's example webhook amount) with **no trial**, charged on creation. One plan with a trial and one without lets both spec'd initial states — `trialing` and immediately-charged — be exercised using only the two plan tiers the assignment asks for. |
| **A2.2** | **Time.** There is no scheduler and tests never sleep. Trial expiry and recurring billing are driven by an explicit `POST /subscriptions/{id}/bill` call, documented as a **test seam standing in for a cron/billing worker**. Making time an input rather than an ambient dependency is what keeps the lifecycle tests deterministic. |
| **A2.3** | **Retries.** A `past_due` subscription tolerates 3 failed charge attempts. The 4th exhausts retries and transitions it to `canceled`, satisfying the `past_due --(retries exhausted)--> canceled` edge. |
| **A2.4** | **Signature.** HMAC-SHA256 over the **raw request body**, hex-encoded, in `X-Provider-Signature`, compared with `crypto.timingSafeEqual`. Verification happens **before** JSON parsing, so a malformed body carrying a bad signature is rejected as unauthorised (401) rather than as unparseable (400). |
| **A2.5** | **Idempotency scope.** Keyed on `event_id`, globally unique, enforced by a database `PRIMARY KEY` — not by application logic alone. See §9. |
| **A2.6** | **Currency.** USD throughout. Multi-currency is an explicit non-goal in the assignment. |
| **A2.7** | **Money.** Integer minor units everywhere. No floating-point arithmetic touches an amount. |

---

## 3. Scope

**In scope**

- API contract and validation for creation, retrieval, cancellation
- Subscription lifecycle: all 7 valid transitions, plus invalid transitions
- Webhook transport concerns: signature validity, malformed payloads
- Webhook idempotency on duplicate `event_id`
- Out-of-order webhook delivery, including a stale failure after a success
- Payment-provider interaction: call count, call arguments, decline, timeout
- Persistence and audit consistency **at every lifecycle stage**, not just creation

**Out of scope** (all listed as non-goals in the assignment)

- Proration, taxes, multi-currency, plan-change billing mathematics
- Real payment-provider integration or SDK contract testing
- Frontend, performance/load testing, production monitoring, report dashboards

**Bonus, attempted only if the mandatory categories are complete**

- Concurrent delivery of the same webhook (the assignment marks this explicitly as
  a bonus, and warns against sacrificing mandatory coverage to reach it)

---

## 4. Test levels

| Level | What it proves | Location |
|---|---|---|
| **L1 — API contract** | status codes, payload shape, validation failures | `tests/api/` |
| **L2 — State machine** | every valid transition; invalid ones rejected | `tests/lifecycle/` |
| **L3 — Persistence** | rows match business rules and the API response | asserted throughout, via `DbVerifier` |
| **L4 — Provider interaction** | call count, arguments, decline/timeout handling | `tests/provider/` |
| **L5 — End-to-end** | API → service → persistence → provider, in one journey | `tests/e2e/` |

**Every level asserts against the database, not only against the response body.**
The single most common failure in this kind of suite is stopping at the HTTP
status code; a 200 that did not persist what it claimed is the bug worth catching.

---

## 5. Real vs mocked

Being explicit about this boundary is a requirement of the assignment, so it is
stated plainly:

| | Component |
|---|---|
| **Real** | The service fixture, the Express HTTP layer, HMAC signature verification, SQLite persistence (real SQL, real constraints, real transactions), the transition table, the repositories |
| **Mocked** | **The payment provider, and nothing else.** A `PaymentProvider` implementation injected at the composition root, with configurable success / decline / timeout outcomes and a recorded call log |
| **Simulated** | Inbound webhooks — constructed and signed by the test suite, including deliberately forged and malformed variants |

The provider is mocked at the **interface seam**, not at the network layer. Nothing
in the fixture makes an outbound HTTP call, so `nock` and `msw` are unnecessary;
introducing them would add a dependency that intercepts traffic that does not exist.

---

## 6. Design patterns and where they live

The assignment warns that naming a pattern not actually present is worse than using
too few. This table is therefore filled in against real paths as the code lands.

| Pattern | Location | The concrete problem it solves |
|---|---|---|
| **Transition table (state machine)** | `src/domain/TransitionTable.ts` | `canceled` has **no outgoing edges**, so "a stray webhook reactivates a canceled subscription" is structurally unreachable rather than merely untested. Replaces a `status` string mutated from several call sites. |
| **Builder** | `tests/support/builders/` | A webhook payload needs an `event_id`, type, subscription, invoice, amount, currency and signature. Repeating that literal across ~30 scenarios would rot; a builder lets each test state only the field it is actually about. |
| **Provider interface + constructor DI** | `src/payments/PaymentProvider.ts`, injected in `src/http/createApp.ts` | Gives tests a substitution point that records arguments, with no network and no module-level monkey-patching. |
| **Repository + application Factory** | `src/persistence/*Repository.ts`, `src/http/createApp.ts` | Keeps SQL out of test bodies so persistence assertions read as business invariants. The factory is the single wiring point where the mock provider is injected. |

**Deliberately not claimed:** plan pricing is a configuration lookup in
`PlanCatalog`, not a Strategy pattern. Calling it one would be the exact
over-claiming the assignment flags.

---

## 7. API contracts

| Endpoint | Codes | Notes |
|---|---|---|
| `POST /subscriptions` | 201, 400, 404, 409 | 400 unknown plan / missing fields; 404 unknown customer |
| `GET /subscriptions/{id}` | 200, 404 | |
| `POST /subscriptions/{id}/cancel` | 200, 404, 409 | 409 when already `canceled` |
| `POST /subscriptions/{id}/bill` | 200, 404, 409 | **Test seam** per A2.2, not a customer-facing endpoint |
| `POST /webhooks/payment-provider` | 200, 400, 401, 404 | 401 bad/missing signature; 400 malformed; 200 + `duplicate` on replay |

Webhook replays return **200, not 409**. A payment provider redelivering an event
is doing the correct thing; answering with an error would invite it to keep
retrying. The response body distinguishes `applied` from `duplicate`.

---

## 8. Database entities and invariants

**Entities** (`src/persistence/schema.sql`): `customers`, `subscriptions`,
`invoices`, `payments`, `webhook_events`, `subscription_events` (audit log).

Invoices and payments are modelled **separately**. An invoice is what is owed for a
period; a payment is one attempt to settle it. Collapsing them would make
"`past_due` after three attempts on one invoice" impossible to express, and would
hide duplicate-charge bugs behind a single row.

**Invariants asserted**

| # | Invariant |
|---|---|
| **I1** | A subscription never reaches `active` without at least one persisted `succeeded` payment |
| **I2** | `canceled` is terminal — no later webhook, of any type, moves it |
| **I3** | Duplicate delivery creates no duplicate invoice, payment, or provider charge |
| **I4** | The provider is called **at most once per genuine billing attempt**, and never at all for rejected creations or replayed webhooks |
| **I5** | Persisted subscription state always equals the API-visible state |
| **I6** | Plan price and trial length are applied consistently at creation and at billing |
| **I7** | No contradictory records — e.g. an `active` subscription whose only invoice is `failed` |

**Engine.** SQLite via **`sql.js`**, a WebAssembly build, chosen over the native
`better-sqlite3` so the suite installs identically on any Node >= 18 and any OS with
no compiler, no Python and no ABI matrix — a reviewer has to be able to run this on
an unknown machine. It is still real SQLite: real `UNIQUE`, `CHECK` and
`FOREIGN KEY` enforcement and real transactions, which is what §9 depends on.

**Seeding and cleanup.** A fresh in-memory SQLite database is built per test file
from `schema.sql`. Nothing is shared across files. This is what prevents false
positives from stale data, and it means tests cannot depend on execution order —
a cheaper and more reliable guarantee than truncating tables between runs.

---

## 9. Webhook idempotency strategy

`webhook_events.event_id` is a **`PRIMARY KEY`**. Each delivery inserts the event
row and applies its effect **inside a single transaction**. A replay fails the
insert, the whole transaction rolls back, and the endpoint returns `200` with
outcome `duplicate`.

Idempotency is therefore a **database guarantee rather than a code convention**.
The distinction is the point: an `if (seen.has(id))` check can be bypassed by a new
call site or lost in a refactor, and under concurrent delivery it is a race. A
uniqueness constraint cannot be, which is also what makes the concurrency bonus
in §3 meaningful rather than decorative.

`payments.idempotency_key` carries the same constraint, so I4 is enforced by the
schema and not only asserted by tests.

---

## 10. Out-of-order and stale delivery

Invoices carry a terminal status. A `payment.failed` arriving for an invoice
already marked `paid` is **persisted** in `webhook_events` with outcome
`ignored_stale`, written to the audit log, and does **not** touch subscription
state. The event is recorded rather than dropped — "we received it and decided to
ignore it" is an auditable outcome; silence is not.

Transitions out of `canceled` are absent from the transition table entirely, so
late events for a canceled subscription are recorded as `ignored_terminal` and
cannot alter state regardless of their type or arrival order.

---

## 11. Known limitations (pre-implementation)

Stated up front rather than discovered at review:

- **Billing is call-driven, not time-driven** (A2.2). This proves the transitions
  but not a real scheduler's behaviour around clock skew or missed runs.
- **SQLite is not the production engine.** Transaction semantics are real, but
  engine-specific concurrency behaviour (row locking, isolation levels under load)
  is not proven by this suite.
- **Single-process concurrency only.** The bonus concurrency test exercises
  interleaving within one Node process, not distributed delivery to multiple
  instances behind a load balancer.
- **No contract test against a real provider SDK.** The provider interface is this
  submission's assumption about the provider's shape; drift would not be detected.
- **Retry count and trial lengths are assumed** (A2.1, A2.3), not specified by the
  assignment. They are centralised in `PlanCatalog` so they are cheap to correct.

---

## 12. Prioritised scenarios

Ordered by risk, so that if the time box binds, the cuts come from the bottom.

**P0 — mandatory**

1. All seven valid transitions, one test each:
   `trialing→active`, `trialing→past_due`, `active→past_due`, `past_due→active`,
   `past_due→canceled` (retries exhausted), `active→canceled`, `trialing→canceled`
2. Invalid transition #1: `payment.succeeded` for a canceled subscription — ignored
3. Invalid transition #2: `payment.failed` for a canceled subscription — ignored
4. Duplicate `event_id` delivered twice: transition applied once, one invoice, one
   payment row, one audit entry, zero additional provider calls
5. Out-of-order: `payment.failed` after `payment.succeeded` for the same invoice
   does not regress an active subscription
6. Invariant I1: no `active` subscription without a persisted successful payment

**P1 — API, validation, provider interaction**

7. Creation returns 201 in the correct initial state, and the provider is called
   with the exact amount, customer, payment method and idempotency key
8. Validation failures (unknown plan, missing `customer_id`, unknown customer,
   missing payment method): correct 4xx **and zero rows persisted and zero
   provider calls**
9. Cancelling an already-canceled subscription: 409, no second audit row
10. Webhook endpoint transport: invalid signature → 401; malformed JSON → 400;
    valid signature for an unknown subscription → 404
11. Provider timeout → `past_due`, failure persisted, never silently `active`
12. Provider decline → `past_due` with the decline reason persisted

**P2 — persistence coherence and end-to-end**

13. Persisted state re-verified at every lifecycle stage, not only at creation
14. Plan price and trial consistent between creation and later billing (I6)
15. Full journey: create → trial ends → active → charge fails → past_due → retry
    succeeds → active → cancel, with DB and provider assertions at each hop

**P3 — bonus**

16. Concurrent delivery of the same `event_id`: exactly one application wins

---

## 13. Validation commands

Results are recorded in the PR description only after being run. No command
appears there that was not actually executed.

```bash
npm run lint          # ESLint flat config
npm run typecheck     # tsc --noEmit
npm test              # full Vitest suite
npm run test:reliability   # idempotency / out-of-order / concurrency
npm run validate:schema    # node scripts/validate_schema.js
```

`scripts/validate_schema.js` is deliberately plain JavaScript with no build step,
so the repository's JS CI workflow — which runs `node scripts/validate_schema.js`
on **Node 18** — works verbatim. It does not merely report success: it inserts a
duplicate and asserts the database refuses it, so that dropping a constraint fails
*here* rather than turning an idempotency test green for the wrong reason.

---

## 14. Responsible AI usage

*(to be completed truthfully at submission: what AI generated, what was directed,
and specifically what was personally run and verified.)*
