# Spec: Commerce remediation

Status: largely done (see §6). Sources: the root `.claude/specs/00-accelerator-review.md` (findings 1–4, 6–9, 15–17) and
`.claude/steering/architecture.md` §4. Each requirement names what to check to know it is done.

## 1. Goal

Commerce starts with clear configuration, runs on the monorepo's core, keeps no credentials in git, has no security
defaults that work in production, and passes its own tests. Then its data survives a restart.

## 2. Requirements

### A. Security (do first)

**A1 Remove committed credentials.**
- Remove `data/google-oauth-config.json` and `data/users.json` from git (`git rm --cached`, then ignore `data/`).
- Read the Google client from `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; read the initial admin from
  `COMMERCE_ADMIN_EMAIL` and `COMMERCE_ADMIN_PASSWORD_HASH`, or create it on first run and print the password once.
- Rotate the Google client secret in the Google console; the committed value is compromised.
- Check: `git ls-files data` is empty; no Google secret value appears in the repository outside `.env.example`.

**A2 No default secrets outside development.** Require these when `NODE_ENV=production`, and refuse to start without them:
`SESSION_SECRET` (replaces the literal `'ecommerce-secret'` in `app.js`), `JWT_SECRET` (replaces the fallback
`ecommerce-secret-key`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Outside production, a missing secret logs a warning and uses a generated random value (not a fixed string).
- Remove the built-in Stripe publishable key fallback (`src/ecommerce/routes/index.js`); require `STRIPE_PUBLISHABLE_KEY`.
- Check: `NODE_ENV=production node app.js` with no secrets exits with a message naming each missing variable.

**A3 Delete dead auth code.** Remove `src/auth/index.js` (requires a missing `src/blog` path and holds a default-admin
password literal). Remove or rename `src/auth/routes/authRoutes.js` and `middleware/authMiddleware.js` (unmounted,
`blog` paths). Check: `grep -r "blog" src` returns nothing; the auth test suite still passes.

**A4 One auth model.** Keep Passport sessions for people signing in to the storefront and admin pages, and JWT bearer
tokens for API clients. Document the split in `architecture.md`. Remove the unused core `authservice` path.

### B. Startup and configuration

**B1 Stripe is optional for non-payment work.** Outside production, with no `STRIPE_SECRET_KEY`, the server starts and
payment routes return `503 {"error":"payments not configured"}`. Today `require('stripe')(undefined)` aborts the process
at load.
- Check: `node app.js` with no Stripe key starts and `POST` to a payment route returns 503.

**B2 Document every variable.** Add `.env.example` listing each variable read by `app.js` and `src/**`, with the default
and whether it is required. Keep the README table in step with it.

### C. Core migration

**C1 Move to the local core.** Change `package.json` to `"nooblyjs-core": "file:../../nooblyjs-core"` (as the other
accelerators do). Rename `dataServe(` to `dataService(` in `app.js` and in every module (`src/**`). Rename the
destructured `dataServe` variables the same way.
- Check: `grep -rn "dataServe" src app.js` is empty; `npm ls nooblyjs-core` shows the local path; boot succeeds.
- Pre-requisite: confirm the local core's APIs used by commerce (`cache`, `searching`, `queue`, `working`, `workflow`,
  `notifying`, `authservice`) match 1.0.0's call signatures. List the differences in the PR before merging.

### D. Correctness

**D1 Fix the five failing seed tests.** Read `tests/unit/seedService.test.js` and `src/ecommerce/services/seedService.js`.
Decide per test whether the service or the test is wrong. Record the decision in the commit message.
- Check: `npx jest` reports 15 of 15 passing.

**D2 Delivery search and analytics.** Fix the 500s on a fresh start:
- `GET /applications/delivery/api/orders` ("Failed to search orders");
- `GET /applications/delivery/api/analytics/overview`;
- `GET /applications/delivery/api/tracking/:orderId` for an unknown id (should be 404, not 500).
- Fix the search-index writes that log `Error adding to search index` at boot.
- Check: on a fresh start all of these return 200 (or 404 for the unknown id); the boot log has no `ERROR` lines.

**D3 Delivery to-do reconciled.** Tick each item in `delivery-todolist.md` that the code does, with the file that does it,
and leave the rest unticked.

### E. Persistence

**E1 Persistent data provider.** Choose one: the core file provider (for single-node) or MongoDB (for more than one
node). Make the provider configurable (`DATA_PROVIDER=memory|file`). Default stays `memory` in development and tests.
- Check: create an order, restart the process, the order is still there (with `DATA_PROVIDER=file`).
- Note: the customers accelerator documents a race with the core file provider under concurrent writes. Dispatch or
  writes must be serialised, or the provider replaced, before `file` is recommended.

### F. Structure

**F1 Split the ecommerce routes.** `src/ecommerce/routes/index.js` (1,633 lines) becomes one file per resource: `products`,
`categories`, `cart`, `orders`, `payments`, `admin`, `uploads`. Behaviour does not change; the existing tests run unchanged.
- Check: no route file exceeds 400 lines; the route list in `README.md` is unchanged (diff the route table before and
  after).

**F2 Commerce tests cover the API.** Add supertest tests for the routes in `README.md`'s API table: status 200 on the
happy path, 401 on a missing bearer token for admin routes, 503 for payment routes without Stripe.

## 3. Order of work

1. A1, A2, A3 (one PR: security).
2. B1, B2 (startup).
3. C1 (core migration) — after the seed tests are understood, so the diff is reviewable.
4. D1, D2, D3.
5. E1 (persistence), F1, F2, A4.

## 4. Out of scope

- Real payment flows and webhook handling beyond the 503 path.
- The warehouse and delivery domain logic beyond D2 and D3.
- Replacing Passport.

## 5. Open questions

1. Persistence provider (E1): file or MongoDB?
2. Are the commerce admin pages meant to be reachable from the public internet? (Decides how strict A2 must be.)
3. Keep the default admin account (A1), or require creating one on first run?

## 6. Status (last run)

| Item | Result | Evidence |
| --- | --- | --- |
| A1 | Done in code. Git index no longer tracks the two data files; `data/` files are gitignored. The Google client secret is still in git history and must be rotated in the Google console, which only the owner can do. | `git ls-files data` is empty; `src/auth/passport-config.js` reads env. |
| A2 | Done, with one difference: `STRIPE_PUBLISHABLE_KEY` is optional, not required in production (the config endpoint answers 503 without it). | `src/config.js`; production start with no secrets exits 1 and names each missing variable. |
| A3 | Done (files deleted, not renamed). | No `blog` text in `src`. |
| A4 | Documented, not restructured. The split is in `architecture.md` §4. `authservice` only appeared in the deleted file. | `architecture.md` §4. |
| B1 | Done. Development start with no Stripe key; payment routes return 503. | Checked by running the server. |
| B2 | Done. | `.env.example`; README table. |
| C1 | Done in substance, with one difference: the local core is used, but the modules keep the name `dataServe` for the adapter, so `grep dataServe` still matches. | `npm ls nooblyjs-core` shows the local path; `src/shared/dataAccess.js`. |
| D1 | Done. The service was fixed where it was wrong (admin password and sample-product errors); the tests were fixed where the mocks were incomplete or expected the wrong field names. | `npx jest`: seed tests 15 of 15 in that file. |
| D2 | Done. Delivery orders, analytics and drivers return 200; unknown tracking id returns 404; no `Error adding to search index` at boot. Also fixed: delivery called `notifying.publish` and `workflow.start`, which the local core lacks (status PATCH and driver registration returned 500); delivery now indexes orders. | Checked by running the server: create 201, search finds it, status 200, driver 201, notification 200, no ERROR lines. |
| D3 | Done: seven items ticked with file references; the rest left open where partly built. | `delivery-todolist.md`. |
| E1 | Done for single-process use. Products and orders survive a restart with `DATA_PROVIDER=file`; search indexes are rebuilt at start. Concurrent-write caveat for the core file provider still applies. | Products 20 then 20 with no re-seed; an order created and updated, then listed after restart. |
| F1 | Done, with different file names (see `architecture.md` §5). No file over 300 lines. Route table identical: 40 routes before and after. | `wc -l`; diff of route lists. |
| F2 | Done. | `tests/api/ecommerce.routes.test.js`, 6 tests. |

Jest: 21 of 21 across three suites (`npx jest`). Jest now sets `forceExit` because nooblyjs-core starts timers that never stop.

Decisions made while doing this:
- Module-level data isolation: the core caches instances by name, so each module passes its own `instanceName`. Without
  this, the three modules shared one store.
- Dead auth files were deleted, not kept.
- Webhooks are refused (503) when `STRIPE_WEBHOOK_SECRET` is unset, rather than accepting unsigned events.
- Seeding fails loudly on a sample product error (it used to skip silently).
- The workflow call in driver registration is removed, not replaced: a stand-in would hide that onboarding does not run.
- Search indexes are rebuilt from stored records at start-up, because the search service keeps its index in memory.

