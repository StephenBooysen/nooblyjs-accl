---
inclusion: always
type: "Spec"
title: "Payments accelerator: spec"
description: "How nooblyjs-accel-payments is built: mount(), modules, records, provider contract, API, events, UI and tests."
tags: ["payments", "accelerator", "spec", "architecture"]
---

# Payments accelerator: spec

> **Status:** Draft v0.1 · 2026-11-19. What and why: `payments-steering.md`. Order: `payments-roadmap.md`.
> Sister accelerators: `../../nooblyjs-accel-customers` (same library shape), `../../nooblyjs-accl-infrastructure`
> (usage source for NooblyJS Cloud).

## 1. Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js ≥ 22.12, **ES modules** (`"type": "module"`); importable from CommonJS hosts with `await import()` |
| HTTP | The host's Express (4 or 5), `express` as a **peer dependency**; routers built with the host's `express.Router` |
| Storage | nooblyjs-core `dataService` (memory / file / MongoDB, the host's choice), containers prefixed `pay_` |
| Cache, queue, scheduling, notifying, logging | nooblyjs-core services, instances named `payments` |
| Customers | `nooblyjs-accel-customers` optional peer: account ↔ customer link, transactional email, timeline |
| Providers | `mock` built in; Stripe and Paystack over `fetch` against their REST APIs (no SDKs), loaded lazily |
| PDF | Invoices rendered as HTML (template) and PDF via a small dependency-free PDF writer (decide in Phase 3) |
| UI | Plain JS + Bootstrap 5.3 + Bootstrap Icons + the NooblyJS theme (`styles.css` verbatim copy) |
| Tests | `node:test`, offline, Express 4 and 5; provider contract suites opt-in |

## 2. Package layout

```
nooblyjs-accel-payments/
├── index.js                     mount(), version, building blocks, adapters
├── src/
│   ├── shared/                  money.js (integer arithmetic, rounding, formatting), ids.js, idempotency.js,
│   │                            ledger.js, context.js, errors.js, http.js (or re-exported from customers, O1)
│   ├── providers/               contract.js, index.js (registry), mock/, stripe/, paystack/
│   ├── billing/                 accounts, catalogue (products, prices, meters), subscriptions, usage,
│   │                            invoices, credit-notes, tax, rating.js (pure), proration.js (pure)
│   ├── payments/                methods, intents, charges, refunds, dunning, webhooks, reconciliation
│   ├── reporting/               revenue, mrr, aging, exports
│   ├── routes/                  one router per module + public webhook router
│   ├── views/                   operator UI (pages, css/payments.css, js/)
│   ├── components/              embeddable customer components (card form, billing summary)
│   └── seed/                    deterministic demo data (NooblyJS Cloud plans, accounts, invoices)
├── test/                        node:test; fixtures/host.js (Express 4/5), providers/contract.test.js
└── .claude/steering/            this folder
```

## 3. `mount(app, eventEmitter, serviceRegistry, options)`

The entry point every NooblyJS accelerator shares.

```js
import payments from 'nooblyjs-accel-payments';   // or: const { mount } = await import(...) from CommonJS

const pay = await payments.mount(app, eventEmitter, serviceRegistry, {
  modules: ['payments', 'billing'],              // billing requires payments; 'reporting' requires billing
  basePath: '/admin',                            // APIs at /admin/payments/api/v1, UIs at /admin/payments/
  containerPrefix: 'pay',
  providers: { data: { type: 'mongodb' }, cache: { type: 'redis' } },   // core providers (default: memory)
  provider: { type: 'stripe', secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET },
  customers: cx,                                 // the customers accelerator's mount result (optional)
  currency: 'USD',
  tax: { rates: [{ country: 'ZA', rate: 1500, inclusive: false, name: 'VAT' }] },   // basis points
  dunning: { retryDays: [1, 3, 5, 7], finalAction: 'mark-uncollectible' },
  auth: { roleResolver: (req) => req.user?.roles ?? [] },
  tenancy: { enabled: false },
  publicUrl: 'https://cloud.nooblyjs.app'        // for webhooks and hosted invoice links
});

pay.events.on('pay.invoice.paid', (event) => { /* … */ });
await pay.billing.recordUsage({ accountId, meter: 'cpu_hours', quantity: 12, idempotencyKey });
await pay.shutdown();
```

Checks before mounting anything: an Express app, an `EventEmitter`, an initialised `serviceRegistry`, valid
modules and dependencies, a valid `basePath`, provider settings (a real provider refuses to start without its secret
and webhook secret; `NODE_ENV=production` refuses `mock`). Returns `{ events, audit, options, version, payments,
billing, reporting, components, shutdown() }`. `shutdown()` stops the scheduled jobs and listeners and is idempotent.

## 4. Records (dataService containers)

All records: `id` (prefixed, e.g. `acct_…`), `tenantId?`, `version` (optimistic concurrency, `ETag: W/"n"`),
`createdAt`, `updatedAt`, `metadata` (string map). Money fields are `{ amount, currency }`.

| Container | Record | Key fields |
| --- | --- | --- |
| `pay_accounts` | billing account | `externalRef` (the host's id, e.g. workspace), `customerId?`, `name`, `email`, `currency`, `country`, `taxId?`, `address`, `defaultMethodId?`, `creditBalance`, `providerCustomerRef`, `status` (`active`/`delinquent`/`closed`) |
| `pay_methods` | payment method | `accountId`, `type` (`card`), `display` (`brand`, `last4`, `expMonth`, `expYear`), `providerRef`, `status` |
| `pay_products` / `pay_prices` | catalogue | product `name`, `meterId?`; price `productId`, `type` (`flat`/`per_unit`/`metered`/`tiered`/`one_off`), `interval` (`month`/`year`), `unitAmount`, `tiers[]`, `aggregate` (`sum`/`max`), `freeAllowance`, `active` |
| `pay_meters` | usage meter | `key` (`cpu_hours`), `unit`, `aggregate` |
| `pay_subscriptions` | subscription | `accountId`, `items[]` (`priceId`, `quantity`), `status` (`trialing`/`active`/`past_due`/`paused`/`cancelled`), `currentPeriod` (`start`, `end`), `cancelAtPeriodEnd`, `trialEnd?` |
| `pay_usage` | usage event | `accountId`, `meter`, `quantity` (integer, smallest unit), `at`, `idempotencyKey` (unique) |
| `pay_invoices` | invoice | `number` (finalised only), `accountId`, `status` (`draft`/`open`/`paid`/`void`/`uncollectible`), `period`, `lines[]` (`description`, `priceId?`, `quantity`, `unitAmount`, `amount`, `period`, `tax[]`), `subtotal`, `tax`, `total`, `creditApplied`, `amountDue`, `dueAt`, `attempts`, `nextAttemptAt` |
| `pay_credit_notes` | credit note | `invoiceId`, `lines[]`, `total`, `reason`, `refundId?` |
| `pay_payments` | payment attempt | `invoiceId?`, `accountId`, `methodId`, `amount`, `status` (`requires_action`/`processing`/`succeeded`/`failed`), `providerRef`, `failure` (`code`, `message`) |
| `pay_refunds` | refund | `paymentId`, `amount`, `status`, `reason`, `providerRef` |
| `pay_ledger` | ledger entry | append-only, double-entry: `txId`, `account` (`receivable`, `cash`, `revenue`, `tax_payable`, `customer_credit`, `refunds`), `debit`, `credit`, `ref` (invoice/payment/refund), `at` |
| `pay_webhooks` | provider event | `provider`, `eventId` (unique), `type`, `receivedAt`, `processedAt`, `result` |
| `pay_idempotency` | idempotency | `key`, `route`, `requestHash`, `response`, `expiresAt` (24 h) |
| `pay_audit` | audit | as in customers (`AuditService`), with amounts kept and card data never present |

Unique and secondary indexes through core `cache` (the customers `BaseRepository` pattern, O1).

## 5. Provider contract

```js
provider = {
  name: 'mock' | 'stripe' | 'paystack',
  customers: { create(account), update(ref, account) },
  methods:   { createSetup(accountRef, { returnUrl }) /* → { clientSecret | authorizationUrl } */,
               confirmSetup(setupRef) /* → method display + ref */, detach(ref) },
  charges:   { create({ accountRef, methodRef, amount, idempotencyKey, description, metadata })
               /* → { ref, status, nextAction? } */, get(ref) },
  refunds:   { create({ chargeRef, amount, idempotencyKey, reason }), get(ref) },
  webhooks:  { verify(rawBody, headers) /* throws */, parse(rawBody) /* → { id, type, data } normalised */ },
  balance:   { transactions({ from, to, cursor }) },        // for reconciliation
}
```

- **Mock:** in-memory; deterministic test cards (`4242…` succeeds, `4000 0000 0000 0002` declines,
  `4000 0027 6000 3184` needs 3-D Secure), failure injection (`failAt`, `once`), out-of-band events (a dispute, a
  refund made on the provider's dashboard), clock control for dunning tests.
- **Stripe:** Customers, SetupIntents + Payment Element for card capture, PaymentIntents with `off_session` for
  renewals, Refunds, webhook signature `Stripe-Signature` (HMAC-SHA256 with tolerance), balance transactions.
- **Paystack:** Customers, `transaction/initialize` (hosted page / Popup) to authorise a card, `charge_authorization`
  for renewals, Refunds, webhook signature `x-paystack-signature` (HMAC-SHA512), settlements for reconciliation.
- Provider refusals map to `ProviderError` (`card_declined`, `authentication_required`, `insufficient_funds`,
  `expired_card`, `invalid`, `unavailable`) with a plain, client-safe message.

## 6. Billing logic

- **Rating** (`rating.js`, pure): `(price, usage[], period) → lines[]`. Metered: aggregate (`sum`/`max`) minus
  `freeAllowance`, floored at 0, × `unitAmount`, or graduated tiers. Per-unit: quantity × unit amount. All integer.
- **Proration** (`proration.js`, pure): by day, `round_half_even(amount × daysRemaining / daysInPeriod)`; plan
  changes add a credit line for the unused old price and a charge for the new one on the next invoice (or immediately
  for upgrades when `prorate: 'now'`).
- **Period close** (scheduled, hourly check): for each subscription whose period ended, build a draft invoice from
  items and usage, apply tax and credit balance, finalise (number `INV-<yyyy>-<seq>` per account currency, gapless
  through the core counter), then collect.
- **Collection:** charge the default method with `idempotencyKey = invoice.id + ':' + attempt`. `requires_action`
  emails a hosted link (3-D Secure); `failed` schedules the next attempt from `dunning.retryDays`; after the last,
  `finalAction` (`mark-uncollectible` or `cancel-subscription`) and the account becomes `delinquent`.
- **Ledger postings** (each a balanced transaction): finalise → Dr receivable / Cr revenue, Cr tax_payable; payment →
  Dr cash / Cr receivable; refund → Dr refunds / Cr cash; credit note → Dr revenue (and tax_payable) / Cr receivable or
  customer_credit; credit applied → Dr customer_credit / Cr receivable.
- **Reconciliation** (daily): provider balance transactions vs payments and refunds; differences become
  `reconciliation.issue` records shown on the operator UI.

## 7. API

`{basePath}/payments/api/v1` and `{basePath}/billing/api/v1`, OpenAPI at `…/openapi.json`, health at `…/health`.
Lists use the customers conventions (`filter[...]`, `sort`, `limit`, `offset`, `{ items, total, limit, offset }`).

| Resource | Notes |
| --- | --- |
| `accounts`, `accounts/{id}` | CRUD; `accounts:lookup?externalRef=` |
| `accounts/{id}/methods`, `methods:setup`, `methods/{id}:confirm`, `methods/{id}:make-default` | Setup returns the provider's client secret or URL |
| `products`, `prices`, `meters` | Catalogue; prices are immutable once used (create a new one) |
| `subscriptions`, `subscriptions/{id}:change`, `:cancel`, `:pause`, `:resume`, `subscriptions/{id}/preview` | Preview returns the next invoice |
| `usage` (POST, batch up to 1,000), `accounts/{id}/usage?period=` | Idempotent by key |
| `invoices`, `invoices/{id}:finalize`, `:pay`, `:void`, `:mark-uncollectible`, `:send`, `invoices/{id}.pdf` | |
| `credit-notes`, `refunds`, `payments` | Refunds and credit notes need `Idempotency-Key` |
| `reports/revenue`, `reports/mrr`, `reports/aging`, `exports/{kind}.csv` | `reporting` module |
| `reconciliation/issues` | |

Public (no session) at `{basePath}/payments/p`: `POST /webhooks/{provider}` (raw body, signature verified, mounted
before JSON parsing and auth), `GET /invoices/{token}` (signed hosted invoice page), `GET /actions/{token}`
(3-D Secure / authorisation hand-off).

In-process API (`pay.billing`, `pay.payments`): `ensureAccount({ externalRef, … })`, `subscribe`, `changePlan`,
`cancel`, `recordUsage`, `previewInvoice`, `listInvoices`, `setupMethod`, `confirmMethod`, `refund`, `creditNote`.
Calls without a context run as the system.

## 8. Events

`pay.account.created|updated|delinquent`, `pay.method.added|removed|expiring`, `pay.subscription.created|changed|
cancelled|past_due`, `pay.invoice.finalized|paid|payment_failed|voided|uncollectible`, `pay.payment.succeeded|failed|
requires_action`, `pay.refund.succeeded`, `pay.reconciliation.issue`. On the shared `eventEmitter` and mirrored to
core `notifying` topic `pay.{module}`; payloads carry ids and amounts, never card data. When the customers accelerator
is passed, the timeline gets invoice and payment entries and these events send transactional emails (invoice ready,
payment failed, card expiring) through its consent and suppression pipeline.

## 9. UI

- **Operator UI** at `{basePath}/payments/`: Overview (MRR, revenue this month, open and overdue, failed payments),
  Accounts (list, account page: methods, subscription, invoices, payments, credit, ledger), Invoices, Payments,
  Refunds, Plans (products, prices, meters), Dunning queue, Reconciliation. Bootstrap 5.3 + the NooblyJS theme; status
  pills follow the theme's tokens (paid teal, open warning, overdue/failed danger, void neutral).
- **Embeddable components** (`pay.components`, served at `{basePath}/payments/components/*.js`, no framework):
  `CardForm` (mounts the provider's hosted fields or opens Paystack's popup; never sees the card number) and
  `BillingSummary` (plan, next invoice estimate, methods, invoices). The host passes an API base and a fetch wrapper
  that carries its session; NooblyJS Cloud styles them with its own theme tokens.

## 10. Security

- PCI DSS **SAQ A**: card data only in provider-hosted fields/pages; CSP additions for the provider's domains are
  documented per provider (Stripe: `js.stripe.com`, `api.stripe.com`, frames; Paystack: `js.paystack.co`).
- Provider secrets come from options/env and are never stored, logged or returned.
- Webhooks: raw-body signature check, timestamp tolerance (Stripe), de-duplicated by event id, processed through the
  queue so a slow handler never times out the provider.
- Refunds above `support.refundLimit` need `finance`; every refund and credit note is audited with reason.
- Tenancy (optional, as customers): `tenancy.enabled` scopes every record by `tenantId`.

## 11. Testing

- Pure modules (money, rating, proration, ledger balance) with table tests including rounding edge cases.
- API tests on Express 4 and 5 with a stand-in host and the mock provider; idempotency replay tests for every
  money-moving route; a "no card data in output" test.
- Dunning and period close with a controllable clock.
- Provider contract suite (`test/providers/contract.test.js`) run against mock always and against Stripe/Paystack
  sandboxes when keys are set.
- Seed story: NooblyJS Cloud plans (Free, Starter, Standard, Pro, Pro Plus; prices `[PRICE]` until decided), meters
  (`cpu_hours`, `memory_gb_hours`, `bandwidth_gb`), account *Exclusivity Life* with a card and three months of invoices.
