# NooblyJS Commerce

Three NooblyJS applications in one Express server: an online shop (`ecommerce`), a warehouse management system
(`warehouse`) and a delivery management system (`delivery`), with a shared sign-in (`/applications/commerce/api/auth`).

Status: **early build, remediation largely done.** The three modules start and serve their screens and APIs without
errors on a fresh start. Data is in memory by default and can be kept on disk with `DATA_PROVIDER=file`. Secrets are read
from the environment, and production refuses to start without them. The open items are listed in
`.claude/steering/architecture.md` §6 and `.claude/specs/remediation.md`.

## Documentation

| Where | What |
| --- | --- |
| `.env.example` | Every environment variable the server reads, with defaults and which are required in production |
| `.claude/steering/architecture.md` | How the server is put together, the auth split, what each module does, known issues |
| `.claude/specs/remediation.md` | The remediation spec, with status against each item |
| `.claude/steering/delivery-todolist.md` | The delivery build plan, with ticks checked against the code |
| `.claude/steering/build-brief.md` | The brief the three modules were built from |
| `.claude/specs/` | Requirements: `ecommerce-requirements.md`, `warehouse-requirements.md`, `delivery-requirements.md` |
| `.claude/learning/nooblyjs-core-usage-guide.md` | How the NooblyJS core services are used |

## Run it

Requires Node.js. Copy `.env.example` to `.env` to set values (the start scripts load `.env` when it exists). The
variables that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | With `production`, the server refuses to start unless the required secrets are set. |
| `SESSION_SECRET`, `JWT_SECRET` | random per process (development) | Required in production. Sessions and tokens reset on restart when random. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | none | Optional in development. Without them the payment routes answer `503`. Required in production. |
| `STRIPE_PUBLISHABLE_KEY` | none | Sent to the storefront for Stripe.js. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Google sign-in is enabled only when both are set. |
| `COMMERCE_ADMIN_EMAIL`, `COMMERCE_ADMIN_PASSWORD` | `admin@ecommerce.com`, generated | Used when the store has no admin yet. If the password is unset, a random one is printed once. |
| `DATA_PROVIDER` | `memory` | `memory` loses data on restart; `file` keeps it under `DATA_DIR`. |
| `DATA_DIR` | `./data/store` | Folder for the file provider; one sub-folder per module. |
| `PORT` | `3003` | HTTP port. |

```bash
npm install
npm start                                    # http://localhost:3003 (development, random secrets, no payments)
STRIPE_SECRET_KEY=sk_test_xxx npm start      # the same, with payment routes enabled
npm run dev                                  # restarted on changes in src/ (nodemon)
npm test                                     # Jest: unit tests and API tests
```

On first start the server seeds sample products and an admin account. The admin password is printed in the log once
unless `COMMERCE_ADMIN_PASSWORD` is set.

## Screens

| Module | Pages (under `/applications/<module>/`) |
| --- | --- |
| Ecommerce | `""` (storefront), `admin.html` |
| Warehouse | `""` |
| Delivery | `""` (dashboard), `driver.html`, `tracking.html`, `analytics.html` |

## API

Each module's API is under `/applications/<module>/api/`. The main routes (method, then path):

- **Ecommerce:** `GET status`, `GET products`, `GET products/:identifier`, `GET categories`, `GET search`, cart
  (`POST cart/add`, `GET cart/:sessionId`, `PUT cart/update`, `DELETE cart/remove`), `POST auth/register`,
  `POST auth/login`, `GET user/profile`, orders (`POST orders`, `GET orders/:id`, `GET orders/track/:orderNumber`),
  payments (`POST payments/create-intent`, `POST payments/confirm`, `POST payments/webhook`, `GET payments/config`),
  content, and the admin routes under `admin/` (products, orders, analytics, inventory). Admin routes and
  `orders/:id` need a bearer token (`Authorization: Bearer <token>`); admin-only routes need an admin account.
- **Warehouse:** `GET status`, `GET health`, `POST products`, `POST locations`, `GET inventory/:productSku`,
  `POST inventory/adjust`, `POST inventory/allocate`, `POST lots`, `POST purchase-orders`, `POST asn`,
  `POST receiving/start`, `POST receiving/item`, `POST putaway/complete/:taskId`, `POST orders`,
  `POST orders/:orderId/validate`, `POST orders/:orderId/allocate`.
- **Delivery:** `GET status`, `POST orders`, `GET orders/:orderId`, `GET orders`, `PATCH orders/:orderId/status`,
  `POST drivers`, `GET drivers/:driverId`, `PATCH drivers/:driverId/status`, `GET drivers/available`,
  `GET tracking/:orderId`, `GET analytics/overview`, `POST notifications`.

Sign-in for the storefront and admin pages is under `/applications/commerce/api/auth`: `POST /login`, `POST /register`, `POST /logout`,
`GET /check`, `GET /google` (when Google is configured). Passport sessions cover this; the JSON API uses bearer tokens.
See `architecture.md` §4.

## Tests

`npm test` runs Jest on `tests/unit` (seed service and job processor) and `tests/api` (the ecommerce API: a public
happy path, `401` for admin routes without a token, and `503` for payment routes without Stripe). The `forceExit` setting
is needed because nooblyjs-core starts timers that are not stopped.

## Licence

ISC (see `package.json`).
