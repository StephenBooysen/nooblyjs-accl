# nooblyjs-accel-payments

Billing and payments for NooblyJS applications, as an accelerator library. Read these first, in this order:

1. `.claude/steering/payments-steering.md`: what we build and why, the roles, the rules on money and card data.
2. `.claude/steering/payments-spec.md`: how: `mount()`, records, provider contract, API, events, UI, tests, decisions (§12).
3. `.claude/steering/payments-roadmap.md`: the build order. Tick a box only when its test passes.

The UI mock-ups are in `.claude/steering/ui/Payments Accelerator.html` (Order payments, Refund a payment, Recurring
payments, Hosted checkout, Payment success).

## Run

```bash
npm install
npm test          # Express 5 then Express 4, offline, mock provider
```

NooblyJS Cloud (`../../nooblyjs-apps/nooblyjs-apps-hero-co`) installs this package with `file:`; npm copies it, so
after a change here copy `src/`, `index.js` and `package.json` into its `node_modules/nooblyjs-accel-payments/`.

## Layout

- `index.js`: `normaliseOptions()` and `mount(app, eventEmitter, serviceRegistry, options)`.
- `src/shared/`: `money.js` (integer minor units, half-even), `store.js` (repositories on core `dataService`),
  `ledger.js` (double entry), `runtime.js` (events, audit, idempotency, roles, clocks), `http.js`, `errors.js`, `ids.js`.
- `src/providers/`: `contract.js`, `mock.js` (test cards), `stripe.js`.
- `src/billing/`: `service.js` (catalogue, subscriptions, usage, period close, invoices, credit notes), `rating.js`,
  `proration.js`, `usage.js`, `document.js` (invoice HTML and the dependency-free PDF), `checkout.js` (the hosted checkout and receipt).
- `src/payments/`: `service.js` (accounts, cards, collection, dunning, refunds, webhooks, reconciliation), `notify.js`
  (transactional emails through the customers accelerator, or the host's `notify`).
- `src/routes/`: `api.js` (both module APIs), `public.js` (webhooks, hosted checkout, 3-D Secure, mock fields).
- `src/components/`: `card-form.js`, `billing-summary.js` (no framework; the host styles them).
- `src/views/`: NooblyJS Pay, the operator UI (`index.html`, `css/payments.css`, `js/app.js`); `css/styles.css` is a
  verbatim copy of the NooblyJS theme: never edit it.
- `src/public/`: the public pages' stylesheet and scripts (`invoice.css`, `checkout.js`, `fields.js` for the mock
  card fields, `action.js` for 3-D Secure).
- `test/`: `node:test` suites and `fixtures/host.js` (a stand-in host with a test clock and captured emails).

## Rules

- Money is integer minor units; never floats. Round half-even, once, where the spec says.
- No card number, CVC or full expiry in any record, log, event or test output (`test/mount.test.js` checks).
- Every money-moving route takes an `Idempotency-Key` and has a replay test.
- No inline `style=""`, `<style>`, inline scripts or `on*=` handlers anywhere (hosts run core's CSP).
- Colours come from the theme tokens in `styles.css`; statuses are words as well as colours.
- Tests run on Express 4 and 5 (`EXPRESS_MAJOR=4` through `test/express4.env`).
