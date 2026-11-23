# nooblyjs-accel-payments

Charge an application's customers: billing accounts, products and prices (flat, per unit, metered, tiered, one-off),
subscriptions, usage, invoices with tax, saved cards through a payment provider (a **mock** provider for development
and tests, **Stripe** for real money), dunning, refunds and credit notes, all posted to a double-entry ledger. It ships
an operator UI (**NooblyJS Pay**), a hosted checkout, and two embeddable components (`CardForm`, `BillingSummary`).

It is a library, like the other NooblyJS accelerators: the host owns Express, the shared `EventEmitter` and the
nooblyjs-core `ServiceRegistry`, and calls `mount()`. It never listens on a port. NooblyJS Cloud (`hero-co`) is the
worked example.

## Install

```bash
npm install nooblyjs-accel-payments   # peer dependencies: express 4 or 5, nooblyjs-core
```

Node 22.12 or later, ESM.

## Mount

```js
import express from 'express';
import { EventEmitter } from 'node:events';
import { mount } from 'nooblyjs-accel-payments';

const app = express();
const pay = await mount(app, new EventEmitter(), serviceRegistry, {
  modules: ['payments', 'billing'],
  basePath: '/admin',                       // UI at /admin/payments/, APIs at /admin/payments/api/v1, /admin/billing/api/v1
  express,
  provider: { type: 'mock' },               // or { type: 'stripe', secretKey, publishableKey, webhookSecret }
  currency: 'USD',
  brand: 'NooblyJS Cloud',                  // on the hosted checkout, emails and invoices
  publicUrl: 'https://cloud.example.com',   // for signed links in emails
  billingUrl: (account) => `https://cloud.example.com/w/${account.externalRef}/billing`,
  seller: { name: 'NooblyJS Cloud', taxId: null, address: null },
  customers,                                // optional: the customers accelerator, for transactional emails
  auth: { roleResolver: (req) => req.user?.payRoles ?? [] },
});
// Leave pay.publicPaths open without a sign-in (webhooks, hosted checkout, components).
```

Mount it **before** any JSON body parser: provider webhooks are verified on the raw body. Shut it down with
`await pay.shutdown()` (idempotent).

Main options: `modules`, `basePath`, `express`, `provider`, `currency`, `brand`, `publicUrl`, `billingUrl(account)`,
`seller`, `tax.rates` (`[{ country, rate (basis points), inclusive, name }]`), `dunning.retryDays` (default
`[1, 3, 5, 7]`), `support.refundLimit` (minor units; larger refunds need the `finance` role), `jobs.enabled`, `clock`
(tests), `signingSecret` (or `PAY_SIGNING_SECRET`; required in production), `customers` or `notify(kind, data)`.
The mock provider is refused when `NODE_ENV=production`.

Roles: `admin`, `finance`, `support`, `readonly`, `service` (steering §5), from `auth.roleResolver(req)`.

## What it serves

| Path (under `{basePath}`) | What |
| --- | --- |
| `/payments/` | NooblyJS Pay, the operator UI: Orders & payments (an invoice is the order: its payments, payment details, Copy payment link, Take a payment), Refund a payment, Recurring (subscriptions: pause, resume, cancel, retry, New schedule), Checkout page, Overview, Accounts, Plans, Reconciliation, Stripe connection, Webhooks |
| `/payments/api/v1/…` | Accounts, payment methods, payments, refunds, dunning, reconciliation, webhooks, `provider`, `overview` (OpenAPI at `openapi.json`) |
| `/billing/api/v1/…` | Meters, products, prices, subscriptions (`:change`, `:cancel`, `:pause`, `:resume`, `/preview`), usage, invoices (`:finalize`, `:pay`, `:void`, `:mark-uncollectible`, `/send`, `.pdf`), credit notes |
| `/payments/p/invoices/{token}` | The hosted checkout (public, signed link): the order and the card form; `?return=/path` (the host's own site only) adds *Back to …* and returns after paying with `?payment=succeeded&invoice=…`. A paid invoice shows its receipt. `/pdf` is the PDF |
| `/payments/p/actions/{token}` | The 3-D Secure hand-off |
| `/payments/p/webhooks/{provider}` | Provider webhooks (raw body, signature checked, de-duplicated) |
| `/payments/components/*.js` | `card-form.js`, `billing-summary.js` |

Money-moving POSTs (refunds, credit notes, subscriptions, invoice actions) take an `Idempotency-Key`.

In process: `pay.payments` (`ensureAccount`, `setupMethod`, `confirmMethod`, `collect`, `refund`, …) and
`pay.billing` (`ensureCatalogue`, `subscribe`, `recordUsage`, `createInvoice` with `collect: false` to email a payment
link instead of charging, `closeDue`, `summary`, …). Events go out on the emitter as `pay.*`.

## Providers and the CSP

- **mock**: test cards (4242 4242 4242 4242 pays; 4000 0000 0000 0341 saves then declines; 4000 0000 0000 0002 is
  declined; 4000 0027 6000 3184 asks for 3-D Secure), failure injection, out-of-band events. Its card fields are a
  same-origin frame that talks to `CardForm` by `postMessage`, so no CSP change is needed.
- **stripe**: SetupIntents and the Payment Element, off-session PaymentIntents, refunds (with Stripe's reason codes),
  webhooks. Allow `https://js.stripe.com` (scripts and frames), `https://hooks.stripe.com` (frames) and
  `https://api.stripe.com` (connect). Card numbers only ever reach Stripe (PCI DSS SAQ A).

No page uses inline script, inline style or `on*=` handlers.

## Develop

```bash
npm test     # node:test, offline, on Express 5 then Express 4, with the mock provider
RUN_STRIPE_TESTS=1 STRIPE_SECRET_KEY=sk_test_… npm run test:express5   # the provider contract against a Stripe sandbox
```

Steering: `.claude/steering/payments-steering.md` (what), `payments-spec.md` (how), `payments-roadmap.md` (order);
mock-ups in `.claude/steering/ui/`.

## License

See `LICENSE`.
