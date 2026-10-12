## Summary

An automated validation suite for a Subscription & Billing Service, plus the
minimal service fixture it validates.

The repository ships a specification only, so this is **Option 2** from
`SDET_ASSIGNMENT.md`. The code under `src/` exists to be tested; the suite under
`tests/` is the deliverable. `docs/TEST_STRATEGY.md` was written and committed
**before** any implementation, and the work was done in seven commits that each
end green.

**75 tests across 10 files**, covering the API contract, all seven lifecycle
transitions, invalid transitions, webhook signature and payload handling,
duplicate and out-of-order delivery, payment-provider interaction, the database
invariants, and one end-to-end journey.

## Test Strategy

**Levels covered**

| Level | What it proves |
|---|---|
| API contract | status codes, payload shape, validation failures |
| State machine | every valid transition; invalid ones rejected or ignored |
| Persistence | rows match the business rules *and* the API response |
| Provider interaction | call count, call arguments, decline, timeout |
| End to end | API -> service -> persistence -> provider, in one journey |

Every level asserts against the database, not only the response body. A 200 that
did not persist what it claimed is the bug worth catching.

**In scope:** creation, retrieval, cancellation, validation failures, the full
lifecycle, webhook transport and business logic, idempotency, out-of-order
delivery, provider failure modes, persistence and audit coherence.

**Out of scope:** proration, taxes, multi-currency, plan-change mathematics, real
provider integration, UI, load testing — all listed as non-goals in the
assignment.

**Not attempted:** the concurrency bonus. Explained under Known Limitations; the
short version is that on this engine such a test cannot fail, and a test that
cannot fail is worse than no test.

**Real vs mocked**

- **Real:** the service, the Express layer, HMAC verification, SQLite
  persistence with live constraints and transactions, the transition table, the
  repositories.
- **Mocked:** the payment provider, and nothing else — an implementation of
  `PaymentProvider` injected at the composition root, with scriptable
  success/decline/timeout outcomes and a recorded call log.
- **Simulated:** inbound webhooks, constructed and signed by the suite,
  including deliberately forged, tampered and malformed variants.

Nothing makes an outbound HTTP call, so `nock`/`msw` would intercept traffic
that does not exist.

## OOP & Design Pattern Choices

Four patterns. Each is in the code at the path given — the assignment warns that
naming an absent pattern is worse than using too few, so this list was audited
against the tree at every phase.

| Pattern | Where | The problem it actually solved |
|---|---|---|
| **Transition table** | `src/domain/TransitionTable.ts`, applied in `src/services/SubscriptionLifecycle.ts` | `canceled` appears only as a destination and has no outgoing edges, so reactivating it is not a guarded bug but a move with nowhere to go. Replaces a `status` string mutated from several call sites. |
| **Builder** | `tests/support/builders/` | Scenarios differ by one field — a replayed `event_id`, a missing `customer_id`. Restating the whole literal each time buried the one thing each test was about. `omitting()` lets validation tests drop a required field without `as any`. |
| **Provider interface + constructor DI** | `src/payments/PaymentProvider.ts`, injected in `src/http/createApp.ts` | Gives tests a substitution point that records arguments, with no network and no module patching. |
| **Repository + application Factory** | `src/persistence/repositories.ts`, `src/http/createApp.ts` | Keeps SQL out of test bodies, so persistence assertions read as business statements. `createApp` is the single wiring point where the mock provider is injected. |

**Deliberately not claimed:** plan pricing is a configuration lookup in
`PlanCatalog`, not a Strategy. Calling it one would be the exact over-claiming
the assignment flags.

**The seam around the provider** is the `PaymentProvider` interface. The
injection point is `createApp({ database, paymentProvider, clock, webhookSecret })`.
Declines and timeouts are returned as outcomes rather than thrown, because they
are ordinary business results with defined lifecycle handling; reserving
exceptions for genuine faults keeps `catch` blocks honest.

## API Validation Approach

Requests and responses go through a typed `ApiClient` over Supertest, so tests
state intent and never mention transport.

Validation failures assert **three** things per case — the response, zero
persistence, and zero provider calls — because a rejected request that still
left a row behind or still charged a card is worse than a wrong status code.
Covered: unknown plan, missing `customer_id`, unknown customer, missing payment
method with no stored default, a plan of the wrong type, an entirely empty body,
cancelling a non-existent subscription (404) and an already-canceled one (409).

**Webhook request handling is tested separately from webhook business logic**,
as the template asks. `tests/api/webhook-endpoint.test.ts` covers transport
only: missing signature (401), forged signature (401), a body altered after
signing (401), malformed JSON (400), unknown event type (400), missing required
fields (400), non-numeric amount (400), unknown subscription (404).

Two ordering decisions carry that endpoint's security, and both have tests:

- The route is registered **before** `express.json()`, so the handler receives
  raw bytes. The HMAC covers the body exactly as sent; verifying a re-serialised
  object would either break honest deliveries through key reordering or let a
  tampered body verify against a normalised form. The test signs a body for
  `amount: 4900`, alters it to `1` in transit, and expects 401.
- The signature is checked **before** parsing, so an unauthenticated caller
  cannot probe the JSON parser. A malformed body with a forged signature returns
  401, not 400 — asserted, not assumed.

## Database Validation Approach

**Entities checked:** `subscriptions`, `invoices`, `payments`, `webhook_events`,
`subscription_events` (audit). Invoices and payments are modelled separately —
an invoice is what is owed for a period, a payment is one attempt to settle it.
Collapsing them would make "three failed attempts on one period" inexpressible
and would hide duplicate-charge bugs behind a single row.

**Invariants asserted**, by `DbVerifier.invariantViolations()` sweeping every
subscription in the database:

| | |
|---|---|
| I1 | never `active` without at least one succeeded payment |
| I2 | nothing follows cancellation in the audit trail |
| I4 | no two payments share an idempotency key |
| I5 | the audit trail ends where the subscription row says it is |
| I6 | invoice amounts follow the plan price |
| I7 | no `active` subscription whose every invoice failed |
| — | every payment settles one of its own subscription's invoices; a canceled subscription carries `canceled_at` |

It returns readable descriptions rather than a boolean, so a failure says what
broke rather than merely that something did.

**Persistence is checked at every lifecycle stage, not just creation.** The
end-to-end test asserts rows, provider calls and the full invariant sweep at
each of seven hops, and ends by pinning the whole recorded journey:
`['trialing', 'active', 'past_due', 'active', 'canceled']`.

**A checker that can only return an empty list proves nothing**, so one test
corrupts the database directly — inserting an `active` subscription with no
payments — and asserts the checker notices and names I1.

**Seeding and cleanup:** a fresh in-memory database per test, built from
`schema.sql`. Nothing is shared, so stale data cannot create a false positive
and tests cannot depend on execution order. That is cheaper and more reliable
than truncating between runs, and it is why there is no cleanup code anywhere.

## Mock Payment Provider & Webhook Validation

`MockPaymentProvider` implements the interface and records every call. It is
hand-written rather than `vi.fn()` because scenarios need outcomes scripted *per
attempt* ("decline, then time out, then succeed") and a call log that reads as
domain data — a mock function expresses both worse.

**Assertions go to arguments, not invocation.** The whole charge request is
compared field by field: customer, payment method, amount, currency, idempotency
key and invoice reference. A retry of an unpaid invoice keeps the same
`reference` but takes a new attempt key, so a provider-side retry of attempt 1
cannot be mistaken for a genuine attempt 2.

**Four tests assert the provider was *not* called** — for a trial subscription,
a rejected creation, a cancellation, and webhook processing including a replay.
The correct call count is sometimes zero, and that is as much a contract as any
other number.

**Idempotency is proven at the storage layer.** `webhook_events.event_id` is a
`PRIMARY KEY`, and `WebhookProcessor` inserts the event row *first*, inside the
same transaction as its effects. A redelivery fails that insert, the transaction
rolls back, and nothing downstream ever ran. Tests prove the transition happens
once, no duplicate invoice or payment row appears, the event is stored once
however many times it is delivered, and the provider charge count does not move.

**Out-of-order delivery:** a `payment.failed` arriving after a `payment.succeeded`
for the same invoice is recorded with outcome `ignored_stale` and does not
regress the subscription, touch the paid invoice, or increment the failure
counter. Any event reaching a canceled subscription is recorded
`ignored_terminal`.

All of these answer **200**. A provider that redelivers is behaving correctly;
a 4xx would only make it retry forever. Ignored events are recorded rather than
dropped, because "received and declined to act" is auditable and silence is
indistinguishable from a lost message.

**Confidence these give:** the service cannot double-charge on replay, cannot be
talked out of a settled invoice by a late message, and cannot resurrect a dead
subscription. What they do not give is proof under genuine concurrency — see
Known Limitations.

## State-Machine / Lifecycle Coverage

All seven transitions from the diagram, one test each:

| | Transition | Trigger |
|---|---|---|
| 1 | `trialing -> active` | trial ends, first charge succeeds |
| 2 | `trialing -> past_due` | trial ends, first charge fails |
| 3 | `active -> past_due` | recurring charge fails |
| 4 | `past_due -> active` | retry charge succeeds |
| 5 | `past_due -> canceled` | retries exhausted |
| 6 | `active -> canceled` | customer/API cancel |
| 7 | `trialing -> canceled` | customer/API cancel |

States are reached by driving the real API, never by writing a row with the
desired status — seeding `status = 'past_due'` would quietly stop testing the
state machine.

**Invalid transitions proven impossible**, each twice over — the table has no
edge, *and* the persisted row and audit trail are unchanged afterwards:

- `canceled -> active` via a billing attempt (409, nothing charged, no invoice opened)
- `canceled -> past_due` via a failing billing attempt (409, no payment row)
- `canceled -> canceled` via a second cancel (409, no duplicate audit row)
- `canceled -> active` via a stray `payment.succeeded` webhook (`ignored_terminal`)
- `canceled -> past_due` via a late `payment.failed` webhook (`ignored_terminal`)

Plus table-level tests: exactly seven transitions declared, `canceled` has no
outgoing edges, every trigger from `canceled` returns undefined, and `canceled`
is the only terminal state.

**Confidence:** the lifecycle cannot be moved except along a declared edge,
because `SubscriptionLifecycle` is the only code that writes the status column
and it consults the table first. A new call site cannot smuggle in a transition;
there is no other method to call.

## Test Architecture

```
tests/support/
  TestHarness.ts         isolated database + mock provider + app, per test
  ApiClient.ts           typed client; transport never appears in a scenario
  MockPaymentProvider.ts records arguments, scriptable per attempt
  WebhookSimulator.ts    signs, forges, tampers with and corrupts deliveries
  DbVerifier.ts          persistence assertions and the invariant sweep
  scenarios.ts           named starting positions, reached through the real API
  builders/              subscription requests, webhook payloads
```

Why it is maintainable: transport lives in one file, SQL lives in one file, and
each scenario names only the field it is about. Test isolation is structural —
a fresh database per test — rather than procedural, so there is no cleanup to
forget. Time is injected, so nothing sleeps and nothing is flaky.

## Validation

Every command below was run; these are the actual results, on **Node 18.18.0**.

```
npm ci                    ->  271 packages in 2s
npm run lint              ->  clean
npm run typecheck         ->  clean
npm run validate:schema   ->  7/7 schema checks passed
npm test                  ->  75 passed (75), 10 files
npm run test:reliability  ->  14 passed (14)
npm run verify            ->  all of the above, in order
```

Verified from a clean setup: `rm -rf node_modules && npm ci && npm run verify`.

**The suite was also checked against itself.** Passing tests prove nothing on
their own, so each phase deliberately broke the implementation and recorded
which tests noticed — **19 mutations, 17 caught, 2 surviving**. Full table in
`TEST_STRATEGY.md §12a`. Examples: treating a provider timeout as success fails
12 tests; reusing one idempotency key fails 11; giving `canceled` an edge back
to `active` fails 6; dropping the `event_id` primary key fails 2.

The two survivors are written up as genuine gaps in §11 rather than quietly
dropped.

## Known Limitations / Next Steps

1. **Concurrency is not tested, and deliberately so.** `sql.js` is synchronous
   and single-process, so `Promise.all` over two webhook deliveries still runs
   them one after the other. Any "concurrent delivery" test would pass whatever
   the implementation did. Mutation testing demonstrated this directly: moving
   the `webhook_events` insert to *after* the effects leaves all 75 tests green,
   because sequentially the two orderings are indistinguishable. The insert-first
   ordering is kept because it is the correct pattern for a real deployment, but
   the confidence comes from reasoning, not from this suite. **Next step:** run
   the same suite against Postgres and add genuinely parallel delivery.
2. **The timing-safe signature comparison is not covered.** Replacing
   `timingSafeEqual` with `===` leaves every test green, because a timing side
   channel is not observable from a functional assertion. **Next step:** a
   statistical timing benchmark, kept out of CI where it would be flaky.
3. **Billing is call-driven, not time-driven.** `POST /subscriptions/{id}/bill`
   stands in for a scheduler so tests control time instead of sleeping. This
   proves the transitions but not a scheduler's behaviour around clock skew or
   missed runs.
4. **SQLite is not the production engine.** Transaction semantics are real, but
   engine-specific concurrency behaviour is not proven.
5. **No contract test against a real provider SDK.** The interface is this
   submission's assumption about the provider's shape; drift would not be caught.
6. **Retry count and trial lengths are assumed** (A2.1, A2.3) rather than
   specified. Centralised in `PlanCatalog` so they are cheap to correct.

## Responsible AI Usage

**Yes, an AI coding assistant was used**, throughout.

**Where it helped:** scaffolding the repetitive layers — repositories, row
types, builders — and drafting documentation. It was also useful as a reviewer
of my own structure, for example in splitting `BillingService` out of
`SubscriptionService` once three call sites wanted the same billing sequence.

**What I directed rather than accepted:** the test strategy and the scenario
priorities, the decision to model every subscription as born `trialing` so that
a no-trial plan takes the same lifecycle edge, the choice to keep
reject-versus-ignore policy with the caller instead of inside the transition
table, and the decision to leave the concurrency bonus unattempted rather than
ship a test that cannot fail.

**What I personally verified:**

- Every result in the Validation section was run, not predicted. No command
  appears above that was not executed.
- The mutation testing was my check on the AI's output as much as my own:
  generated tests that look thorough can assert nothing, and deliberately
  breaking the implementation is how I confirmed they bite. Two mutations
  survived and are reported rather than hidden.
- I corrected real errors found along the way: an initial `better-sqlite3`
  dependency that would not install on the CI's Node version, an ESLint range
  that pulled Node-20-only transitive dependencies, a `T extends Row` generic
  bound that type-checking caught while all tests were passing over it, a
  convoluted provider test I rewrote, and two paths in the strategy document
  that no longer matched the tree.

**Candid assessment:** the AI accelerated the typing. The judgement calls —
what to test, what to leave out, what to admit does not work — are the parts
worth assessing, and they are the parts I own.

## Author Checklist

- [x] Linting passes — `npm run lint`, clean
- [x] Type check passes — `npm run typecheck` (`tsc --noEmit`), clean
- [x] Test suite passes — `npm test`, 75/75
- [x] Schema/setup validation passes — `npm run validate:schema`, 7/7
- [x] Every listed lifecycle transition is exercised by at least one test — all seven, in `tests/lifecycle/valid-transitions.test.ts`
- [x] At least two invalid transitions are proven impossible — five scenarios plus four table-level tests
- [x] Webhook idempotency (duplicate `event_id`) is tested — `tests/reliability/webhook-idempotency.test.ts`
- [x] README was tested from a clean setup — `rm -rf node_modules && npm ci && npm run verify`
