---
inclusion: always
type: "Steering"
title: "Payments accelerator: steering"
description: "What nooblyjs-accel-payments is, who it is for, what v1 does and does not do, and the rules every change follows."
tags: ["payments", "accelerator", "steering"]
---

# Payments accelerator: steering

> **Status:** Draft v0.1 · 2026-11-19. The folder is empty; this is the starting point. How it is built:
> `payments-spec.md`. The order it is built in: `payments-roadmap.md` (tick its boxes in the same change as the work).
> First consumer: **NooblyJS Cloud** (`nooblyjs-apps/nooblyjs-apps-hero-co`), whose plans, usage and *Add a card*
> flow need it (`hero-co/.claude/steering/roadmap.md` Phase 7).

## 1. In one paragraph

`nooblyjs-accel-payments` is a NooblyJS accelerator that lets an application **charge its customers**: keep billing
accounts, sell **plans** with **prices** (flat, per seat, or **metered usage**), run **subscriptions**, turn usage into
**invoices**, collect them from a **saved card** (or another method a provider supports), retry failed payments,
refund, and keep an auditable **ledger** of every money movement. It never touches raw card numbers: a payment
**provider** (mock first, then Stripe and Paystack) holds them. Like `nooblyjs-accel-customers` it is a **library**:
the host owns Express, the `EventEmitter` and the nooblyjs-core `ServiceRegistry`, and calls
`mount(app, eventEmitter, serviceRegistry, options)`.

## 2. Who it is for

| Person | What they want | What they must never have to do |
| --- | --- | --- |
| **Application developer** (NooblyJS Cloud's team) | Call `pay.billing.recordUsage()` and `pay.billing.subscribe()` from their code; get `pay.invoice.paid` events; drop a card form into their page. | Learn a provider's SDK, handle webhooks' signatures, write proration or dunning logic. |
| **End customer** (a NooblyJS Cloud workspace owner) | Add a card, see what they will pay, download invoices, change plan. | Enter their card on the application's own servers. |
| **Finance / operator** (NooblyJS staff) | See revenue, open and overdue invoices, failed payments; refund; issue credit; export for accounting. | Reconcile the provider's dashboard by hand. |
| **Support agent** | See a customer's subscription, invoices and payments next to their customer 360. | Get finance rights to answer "why was I charged?". |

## 3. Principles

1. **Money is integers.** Amounts are integer minor units with an ISO 4217 currency (`{ amount: 2500, currency: 'USD' }`).
   No floats anywhere, rounding only at defined points (line totals, tax), half-even.
2. **The provider holds card data.** Only provider tokens and display data (brand, last 4, expiry) are stored. Card
   capture uses the provider's hosted fields or hosted page (PCI DSS **SAQ A** scope for the host).
3. **Every change is idempotent.** Every write that moves money takes an `idempotencyKey`; webhooks are de-duplicated by
   provider event id; replays never charge twice.
4. **The ledger is the truth for money; the provider is the truth for whether a charge happened.** Webhooks and a
   reconciliation job keep the two agreeing; a disagreement is flagged, never silently fixed.
5. **Nothing is deleted.** Invoices are finalised then paid, voided or marked uncollectible; corrections are credit notes
   and refunds. Every write is audited.
6. **Mock first.** Every feature works offline on the mock provider (tests, seed story, screens) before a real
   provider adapter.
7. **Same shape as the other accelerators.** `mount()` like customers and infrastructure; storage through core
   `dataService`; events on the shared emitter mirrored to core `notifying`; roles resolved by the host.

## 4. Scope

### In scope for v1

| Area | Capabilities |
| --- | --- |
| **Billing accounts** | One per paying party (a NooblyJS Cloud workspace), linked to a customer in `nooblyjs-accel-customers` when it is mounted; currency, country, billing email, tax id, address. |
| **Catalogue** | Products and prices: flat recurring, per unit (seats), metered (sum or max of usage per period), tiered (graduated), one-off; monthly or yearly; free tier allowances. |
| **Payment methods** | Card through the provider's hosted fields (setup intent → saved method); default method; remove; expiring-card notice. |
| **Subscriptions** | Create, change plan (proration by day), change quantity, cancel at period end or now, trial, pause collection. |
| **Usage** | `recordUsage(account, meter, quantity, { at, idempotencyKey })`; aggregation per period; usage preview for the current period. |
| **Invoices** | Draft at period end → finalise (numbered) → collect; one-off invoices; line items with periods; tax lines; PDF and HTML; credit notes. |
| **Collection** | Charge the default method; 3-D Secure via the provider when required; failed payment retries (dunning schedule); emails through the customers accelerator's transactional sender when mounted. |
| **Refunds and credits** | Full or partial refund; account credit balance applied to the next invoice. |
| **Tax** | Tax rates table (e.g. South Africa VAT 15%), inclusive or exclusive, by country; tax id on invoices. No tax engine in v1. |
| **Providers** | `mock` (default), **Stripe**, **Paystack**; webhooks verified and idempotent. |
| **Ledger and reporting** | Double-entry ledger of every money movement; revenue, MRR, open/overdue, failed payments; CSV export. |
| **Operator UI** | Accounts, subscriptions, invoices, payments, refunds, plans; dunning queue; reconciliation issues. |
| **Embeddable customer UI** | A card form component and a billing summary component the host drops into its own pages (NooblyJS Cloud's Billing page). |

### Out of scope for v1

Marketplace / split payments, payouts to third parties, multi-currency per account (one currency per account),
automatic tax calculation (Stripe Tax, etc.), revenue recognition schedules, quotes, bank debit orders and EFT
(after v1, Paystack/Stripe methods), crypto, storing card data ourselves, a hosted checkout of our own.

## 5. Roles

Resolved by the host (`auth.roleResolver`), like the customers accelerator.

| Role | May |
| --- | --- |
| `admin` | Everything, including provider settings and tax rates. |
| `finance` | Plans and prices, invoices (finalise, void, mark uncollectible), refunds, credit notes, exports. |
| `support` | Read accounts, subscriptions, invoices and payments; resend an invoice; refunds up to `support.refundLimit`. |
| `readonly` | Read everything (payment method display data only). |
| `service` | The host's own code through API keys: usage, subscriptions, payment method setup on behalf of an account. |
| `account-owner` (scoped) | Through the host only: their own account's methods, invoices and plan changes. |

## 6. Rules for every change

- `mount()` checks everything before mounting anything, never listens on a port, never initialises the registry.
- Express 4 and 5 (the host's); no wildcard routes; every async route wrapped so rejections reach the error handler.
- Errors: `{ error: { code, message, details[] } }`; server faults never expose internal messages.
- Every money-moving route needs `Idempotency-Key`; every write is audited; refusals are recorded.
- No raw card data in logs, records, events or errors (a test greps the test run's output for card-like numbers).
- Tests: `node:test`, offline on the mock provider, on Express 4 and 5; provider adapters have contract suites run
  against their sandboxes when keys are present (`RUN_STRIPE_TESTS=1`, `RUN_PAYSTACK_TESTS=1`).
- UI: plain JavaScript on Bootstrap 5.3 and Bootstrap Icons, with the NooblyJS theme
  (`nooblyjs/styling/styles.css`, copied verbatim, as core and customers do); no inline styles or scripts (core CSP).

## 7. Success measures

- NooblyJS Cloud goes from "free tier exceeded" to a saved card and a paid first invoice without leaving its own UI.
- Ledger, invoices and provider balance reconcile to the cent every day; zero double charges in replay tests.
- A failed payment is retried on schedule and the account owner is told each time, without operator action.

## 8. Open decisions

- **O1** Reuse `nooblyjs-accel-customers`' shared building blocks (`schema`, `BaseRepository`, `rbac`, `AuditService`,
  `DomainEventBus`) as a peer dependency, or copy them. **Recommendation:** peer dependency now; extract to a shared
  package when a third accelerator needs them.
- **O2** First real provider: Stripe (global, mature) or Paystack (South Africa, ZAR, local cards). **Recommendation:**
  both behind the same contract; Stripe first for USD pricing, Paystack second for ZAR.
- **O3** Who owns the plan table for NooblyJS Cloud: the payments catalogue (recommended) or the app.
- **O4** Invoice numbering format and per-country legal requirements (South African VAT invoices need specific fields).
