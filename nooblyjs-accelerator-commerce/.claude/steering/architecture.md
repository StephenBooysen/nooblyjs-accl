# Architecture: NooblyJS Commerce

What the code does today, checked against the source. Product intent is in `.claude/specs/`; the delivery build plan is
`delivery-todolist.md`; the remaining remediation work is `.claude/specs/remediation.md`.

## 1. Shape

One Node.js process, Express 4, CommonJS. `app.js` loads configuration, builds the app and mounts three modules and an
auth router:

| Mount | Source | What |
| --- | --- | --- |
| `/applications/warehouse/…` | `src/warehouse/` | Warehouse screens and API |
| `/applications/ecommerce/…` | `src/ecommerce/` | Storefront, admin screens and API |
| `/applications/delivery/…` | `src/delivery/` | Delivery dashboard, driver, tracking, analytics screens and API |
| `/api/auth/…` | `src/auth/routes.js` | Passport local and (optional) Google sign-in |
| `/` | `public/` | Static files (`styles.css`) |

Each module is a function `(options, eventEmitter, serviceRegistry)`. It registers its API routes and its views. Modules
are not separate processes.

## 2. Configuration

`src/config.js` reads every environment variable once (`loadConfig`). The full list, with defaults, is in
`.env.example`.

- In production (`NODE_ENV=production`) the server refuses to start unless `SESSION_SECRET`, `JWT_SECRET`,
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. The error names each missing variable.
- Outside production a missing `SESSION_SECRET` or `JWT_SECRET` is replaced by a random value for that process, with a
  warning. Sessions and tokens therefore reset on restart unless the secrets are set.
- Payments are optional outside production. Without `STRIPE_SECRET_KEY` the server starts, and every payment route
  answers `503 {"error":"payments not configured"}`. The webhook refuses events when `STRIPE_WEBHOOK_SECRET` is unset.
- Google sign-in is enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set.

## 3. Core services

`app.js` requires `nooblyjs-core` from the local checkout (`file:../../nooblyjs-core`, version 1.0.10) and calls
`initialize(app, eventEmitter)`, then asks for services by name. Services in use: logger (console), cache (memory),
queue, scheduling, searching, measuring, notifying, working, workflow, filing (local), and the data service.

The core caches each service instance by name, provider and `instanceName`, and ignores options given after the first
call. Commerce therefore gives every module its own `instanceName` (`ecommerce`, `warehouse`, `delivery`, `app`), so
modules do not share containers.

**Data access.** The modules call the data service through two adapters in `src/shared/`:

- `dataAccess.js` (`createDataAccess`) gives the modules the method names they use (`add`, `list`, `read`, `update`,
  `jsonFindById`, `jsonFindAll`) over the core's `dataService`. Each stored record carries its own `id`, and `update`
  merges the patch into the stored record. The variable the modules hold it in is still named `dataServe`.
- `searchAccess.js` (`createSearchAccess`) gives the modules `index`, `add`, `remove` and `search(term, container)`
  over the core's searching service.

**Persistence.** `DATA_PROVIDER=memory` (the default) keeps data in process memory; it is lost on restart.
`DATA_PROVIDER=file` keeps data under `DATA_DIR` (default `./data/store`), one folder per module. Products survive a
restart and the seed does not run twice (checked by starting the server twice). Orders persist too: an order created,
then updated, is still there after a restart. The search index is in memory, so `ecommerce` (products) and `delivery`
(orders) rebuild it from the stored records at start-up; search results after a restart were checked. The core's file provider does not
serialise concurrent writes, so `file` is for a single process with light write load until that is fixed (see the
customers accelerator's notes).

## 4. Authentication

Two mechanisms, split by who calls:

- **Passport sessions** for people using the storefront and the sign-in pages: `src/auth/passport-config.js` (local
  strategy with bcrypt, and Google when configured). Users are read from `data/users.json`, or from `USERS_FILE` when
  it is set. The session cookie is signed with `SESSION_SECRET`.
- **JWT bearer tokens** for API clients: `POST /applications/ecommerce/api/auth/login` returns a token signed with
  `JWT_SECRET`, and admin routes check it (`requireAuth`, then `requireAdmin` for admin-only routes). Requests without a
  token get `401`.

The two do not share state. A signed-in browser session does not authenticate the admin API, and a bearer token does
not create a session.

## 5. Modules today

**Ecommerce** (`src/ecommerce/`). `index.js` wires the services and calls `routes/index.js`, which builds a shared
context (`routes/context.js`, including `requireAuth`/`requireAdmin`) and registers each section in its own file:

| File | Routes |
| --- | --- |
| `products.js` | product list, product by id, categories, debug, seed trigger, search |
| `cart.js` | add, get, update, remove |
| `users.js` | register, login, profile |
| `orders.js` | create, get, track by order number |
| `payments.js` | Stripe payment intent, confirm, webhook, publishable key |
| `content.js` | content list, read, create, update, delete, view count |
| `admin-products.js` | create, update, delete, image upload |
| `admin-orders.js` | list, status, refund |
| `admin-analytics.js` | sales, products, customers |
| `inventory.js` | list, update |

The route table is unchanged from the single-file version (40 routes, compared before and after the split). Services:
`productService`, `categoryService`, `seedService` (seeds sample products and one admin user at boot), `jobProcessor`.

**Admin user.** `seedService` creates the first admin (`isAdmin: true`, `status: 'active'`) only when no admin exists.
Its email is `COMMERCE_ADMIN_EMAIL` (default `admin@ecommerce.com`). Its password is `COMMERCE_ADMIN_PASSWORD` if set;
otherwise a random password is generated and printed once in the start-up log. No password is stored in the source.

**Warehouse** (`src/warehouse/`). Modules in `modules/`: `inventory`, `inbound` (purchase orders, ASN, receiving,
put-away), `outbound` (orders, validate, allocate, picking), `resource` (task timing, recorded with `measuring.histogram`),
`delivery` (hand-off to delivery). Routes in `routes/index.js`. `src/warehouse/components/datamanager/` exists but
nothing requires it.

**Delivery** (`src/delivery/`). Routes in `routes/index.js`: orders (create, get, list, search, status), drivers
(create, get, status, available), tracking by order, analytics overview (stored as a snapshot in `analytics_snapshots`),
notifications. Views: `index.html` (dashboard), `driver.html`, `tracking.html`, `analytics.html`. The drivers route
`/drivers/available` is registered before `/drivers/:driverId`, so it is not shadowed.

## 6. Known issues

Checked against the code and by running the server:

**Resolved in the remediation work**

- Startup needed a Stripe key (now optional outside production; see §2).
- Search indexing logged `Error adding to search index` at boot, and delivery order search returned 500 (now 200; the
  boot log has no errors).
- Delivery never indexed orders, so search could not find an order created through the API. Orders are now indexed on
  create and on status change.
- Delivery called `notifying.publish` and `workflow.start`, which the local core does not provide. Status updates and
  driver registration returned 500. Now `notifying.notify` is used; the workflow call is removed (see below).
- Analytics returned 500 (now 200), and tracking returned 500 for an unknown id (now 404).
- Five Jest tests failed in `seedService.test.js` (now 15 of 15 in that file; the mocks were incomplete, and the tests
  expected field names the service does not use).
- Committed secrets: `data/google-oauth-config.json` and `data/users.json` are removed from the git index and listed in
  `.gitignore`. The files still exist on disk.
- Hard-coded defaults: the session secret, JWT fallback, Stripe publishable test key, and the webhook test secret are
  removed. The admin password literal is removed.
- Dead auth code (`src/auth/index.js`, `authRoutes.js`, `authMiddleware.js`, `userManager.js`) is deleted; nothing
  referenced it, and no `blog` path remains in `src`.
- The startup banner names the commerce server.

**Still open**

1. **The Google client secret and the git history.** The Google client secret was committed, so it is in git history.
   Only the Google console can rotate it. Removing it from history needs a rewrite, which has not been done.
2. **Data-service method names.** The modules still use `dataServe` as a variable name for the adapter, not
   `dataService` as the remediation spec's C1 check expects. The adapter is in place and the behaviour is correct.
3. **Driver onboarding workflow is not running.** The workflow service in nooblyjs-core is an HTTP client for a separate
   workflow server. Nothing here runs one, so the onboarding step was removed and new drivers stay in
   `pending_verification`. `workflow` reports `not configured` on `GET status`. Configure a workflow server or accept
   manual onboarding.
4. **Order status values are not validated.** `PATCH orders/:id/status` stores any string. The lifecycle in the
   to-do list (created, assigned, picked up, in-transit, delivered, failed) is not enforced.
5. **Concurrent file writes.** See §3.
6. **Stripe publishable key is optional.** The spec asked for it to be required; it is not in the production list, and
   the config endpoint returns 503 when it is unset.
7. **Unused components.** `src/ecommerce/components/datamanager/` and `src/warehouse/components/datamanager/` are not
   wired in.
8. **Route file names.** The routes split into `products`, `cart`, `users`, `orders`, `payments`, `content`,
   `admin-products`, `admin-orders`, `admin-analytics` and `inventory`, rather than the names the spec suggested. Each
   file is under 300 lines.

## 7. Conventions

- Routes are registered with a template-string prefix: ``app.get(`/applications/${app_path}/api/...`)``. The
  `app_path` option defaults to the module name.
- Services are passed in through `serviceRegistry`; modules do not create their own storage.
- Configuration is read through `src/config.js`, not directly from `process.env` in new code.
- Tests live in `tests/unit/` and `tests/api/` and run with Jest (`npm test`). `forceExit` is set in the Jest config
  because nooblyjs-core starts interval timers that are never stopped.
