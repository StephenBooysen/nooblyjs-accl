---
inclusion: always
type: "Roadmap"
title: "Payments accelerator: roadmap"
description: "The build order for nooblyjs-accel-payments, phase by phase, with exit checks."
tags: ["payments", "accelerator", "roadmap"]
---

# Payments accelerator: roadmap

> **Status:** Draft v0.1 · 2026-11-19. What: `payments-steering.md`. How: `payments-spec.md` (§ numbers below point
> there). **Tick a box in the same change as the work.** A phase is done when its exit check passes.
> NooblyJS Cloud's billing (`hero-co/.claude/steering/roadmap.md` Phase 7) needs Phases 0–3.

Ground rules: mock provider first; `npm test` offline on Express 4 and 5; every money-moving route has an idempotency
replay test; no card data anywhere in records, logs or test output.

## Where we are (2026-11-23)

Phases 0–2 are done. Phase 3 is done on the mock provider (with the operator UI and hosted checkout of the mock-ups in
`ui/`); its exit check needs a Stripe sandbox. NooblyJS Cloud's Phase 7 runs on it.

## Where we start (2026-11-19)

`nooblyjs-accel-payments/` is an empty folder in the accelerators monorepo. The shape to copy is
`nooblyjs-accel-customers` (library, `mount()`, core `dataService`, module routers and admin UI); the test style is
`nooblyjs-accl-infrastructure` (`node:test`, Express 4 and 5).

## Phase 0 — Skeleton

- [x] 0.1 `package.json` (ESM, `engines >= 22.12`, `express` and `nooblyjs-core` peer dependencies, dev links `file:../../nooblyjs-core`), `README.md`, `CLAUDE.md` pointing at these three files, `LICENSE`.
- [x] 0.2 `mount(app, eventEmitter, serviceRegistry, options)`: option checks before mounting anything, module dependency check, `shutdown()` idempotent (§3).
- [x] 0.3 Shared layer: `money.js` (integer arithmetic, half-even rounding, formatting per currency) with table tests; ids; errors; http helpers; idempotency store; decide O1 (reuse customers' building blocks or copy).
- [x] 0.4 Event bus (`pay.*` on the emitter, mirrored to core `notifying`), audit service, RBAC with the roles in steering §5.
- [x] 0.5 Provider contract and the **mock provider** with test cards, failure injection and clock control (§5).
- [x] 0.6 Test harness: stand-in host on Express 4 and 5; health and OpenAPI routes; "no card data in output" test.

**Exit check:** a host mounts `payments` and `billing` on Express 4 and 5; a missing option mounts nothing; `/health`
and `/openapi.json` answer; `npm test` green offline.

## Phase 1 — Accounts, catalogue and payment methods

- [x] 1.1 Billing accounts API and in-process `ensureAccount`; link to the customers accelerator when passed.
- [x] 1.2 Products, prices (flat, per unit, metered, tiered, one-off), meters; prices immutable once used.
- [x] 1.3 Payment methods: setup → confirm → default → remove, through the provider; display data only.
- [x] 1.4 `CardForm` component on the mock provider (a hosted-fields stand-in page).
- [x] 1.5 Operator UI: shell, Accounts list and account page (methods), Plans.
- [x] 1.6 Seed story: NooblyJS Cloud plans and meters; account *Exclusivity Life* with a card.

**Exit check:** a host creates an account for a workspace, a person saves a test card through `CardForm`, and the
operator sees it as "Visa ·· 4242" with no card number stored anywhere.

## Phase 2 — Subscriptions, usage and invoices

- [x] 2.1 Subscriptions: create, trial, change plan with proration (pure `proration.js`), quantity, cancel, pause.
- [x] 2.2 Usage: batch, idempotent recording; aggregation; current-period preview.
- [x] 2.3 Rating engine (pure `rating.js`) with free allowances and graduated tiers; table tests.
- [x] 2.4 Period close job: draft → tax → credit → finalise with gapless numbers; one-off invoices.
- [x] 2.5 Tax rates table (inclusive/exclusive, by country) and tax lines; VAT fields on invoices (O4).
- [x] 2.6 Ledger postings for finalise and credit; balance check test (every transaction balances).
- [x] 2.7 Invoice HTML; operator Invoices pages; `BillingSummary` component.

**Exit check:** with a controllable clock, a month of seeded usage closes into a correct, numbered invoice whose lines
match the rating tables, and the ledger balances.

## Phase 3 — Collection, dunning, refunds and Stripe

- [x] 3.1 Collect invoices off-session; `requires_action` hand-off page; payment records and ledger postings.
- [x] 3.2 Dunning: retry schedule, final action, delinquent accounts; emails via the customers accelerator when mounted.
- [x] 3.3 Refunds (full/partial) and credit notes with ledger postings; support refund limit.
- [x] 3.4 Webhooks: raw-body route before auth, verification, de-duplication, processing through the queue.
- [x] 3.5 **Stripe adapter** (Customers, SetupIntents + Payment Element, off-session PaymentIntents, Refunds, webhooks, balance transactions); contract suite against a Stripe sandbox.
  *2026-11-23:* the adapter is built and checked against a stand-in Stripe API (`test/providers/contract.test.js`).
  The sandbox run passed the same day with a restricted test key (`RUN_STRIPE_TESTS=1 STRIPE_SECRET_KEY=rk_test_…`):
  a customer, a card saved through a SetupIntent (`pm_card_visa`), an off-session charge, a partial refund, balance
  transactions and detaching the card, all on Stripe. Webhooks from Stripe and the Payment Element in a browser are
  not in it: they need `STRIPE_WEBHOOK_SECRET` (Dashboard → Webhooks, or `stripe listen`), as does the exit check below.
- [x] 3.6 Invoice PDF (choose the writer); hosted invoice page with signed link.
- [x] 3.7 Operator UI: Payments, Refunds, Dunning queue.

**Exit check:** on a Stripe sandbox, a saved card pays an invoice off-session; a declining card is retried on schedule
with an email each time and ends `uncollectible`; a 3-D Secure card completes through the hand-off page; a partial
refund posts to the ledger; replaying every webhook twice changes nothing.

## Phase 4 — Paystack, reconciliation and reporting

- [ ] 4.1 **Paystack adapter** (customers, initialise/popup authorisation, `charge_authorization`, refunds, webhooks, settlements); ZAR seed account; contract suite against a Paystack test account.
- [ ] 4.2 Daily reconciliation against provider balance/settlements; issues screen.
- [ ] 4.3 Reporting module: revenue, MRR, aging, failed payments; CSV exports.
- [x] 4.4 Operator Overview page.
- [ ] 4.5 Card expiring notices; account credit balance management.

**Exit check:** a ZAR account pays through Paystack; a day's reconciliation matches to the cent and flags a refund made
on the provider's dashboard; MRR and aging match the seeded data.

## Phase 5 — v1.0 hardening

- [ ] 5.1 Tenancy mode (`tenantId` on every record) and its isolation tests.
- [x] 5.2 Production checks: refuse `mock` in production, required secrets, CSP notes per provider.
- [ ] 5.3 Security review (webhooks, idempotency, refunds, audit, data in logs).
- [ ] 5.4 Docs: README, OpenAPI complete, host integration guide (NooblyJS Cloud as the worked example).

**Exit check:** NooblyJS Cloud runs its Phase 7 exit check against this accelerator on a Stripe sandbox.

## Phase 6 — Beyond v1

- [ ] 6.1 Bank debit orders / EFT through Paystack and Stripe methods.
- [ ] 6.2 Automatic tax calculation (provider tax services).
- [ ] 6.3 Quotes and annual prepay contracts.
- [ ] 6.4 Revenue recognition schedules.
- [ ] 6.5 Multi-currency per account.
