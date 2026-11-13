# Review: state of the nooblyjs-accl accelerators and what to do next

Date: 2026-11-13. Scope: the four accelerator folders and the root launcher, as they are in the repository now. Each
finding was checked by running the code or reading the file it cites. Where a check was not run, the finding says so.

Specs for the work below, one per project:

| Spec | Covers |
| --- | --- |
| `01-monorepo-launcher.md` (this folder) | Root launcher, shared tooling, CI, the empty accelerators, core version policy |
| `nooblyjs-accelerator-commerce/.claude/specs/remediation.md` | Commerce: boot, security, data, failing tests, core migration |
| `nooblyjs-accelerator-customers/.claude/spec/improvements.md` | Customers: CI, file provider, contact centre, hygiene |
| `nooblyjs-accelerator-infrastructure/.claude/specs/improvements.md` | Infrastructure: cloud adapters, security of stored credentials, hardening |

## 1. Where each accelerator stands

| Accelerator | Working today | Verified by running | Main gap |
| --- | --- | --- | --- |
| Infrastructure (Noobly Cloud) | Mock cloud: VMs, operations, jobs, secrets, screens | `npm run test:express5`: 120/120 pass | No real GCP or AWS adapter, so nothing is created in a real cloud |
| Customers (library) | Customer 360, marketing send pipeline, tracking, webhooks, admin UIs | `jest`: 13 suites, 243/243 pass; demo host serves 200s | Contact centre (Phase 3) is a status page; no CI in this repo |
| Commerce (3 apps) | Storefront, warehouse, delivery screens and APIs respond | `jest`: 5 of 15 fail (all `SeedService`); boots only with `STRIPE_SECRET_KEY`; delivery order search and analytics return 500 | Data is in memory; security defaults; on an old core version |
| Analytics, Studio | Nothing | `package.json` only | Not started |
| Root launcher (`app.js`) | Nothing | Exits: `Cannot find module 'passport'` | Its only job is to load infrastructure, and it cannot start |

## 2. Findings, in priority order

Priority 0 means it blocks use or is a security exposure. Priority 1 means it blocks the next milestone. Priority 2 is
cleanup.

**P0**

1. **Committed credentials in commerce.** `nooblyjs-accelerator-commerce/data/google-oauth-config.json` contains a
   Google OAuth `client_secret`; `data/users.json` contains a bcrypt hash. Both are tracked by git (the infrastructure
   `data/` folder is ignored, so it is fine). Rotate the secret; move both out of the repo.
2. **Hard-coded defaults that run in production.** Commerce's session secret is the literal `'ecommerce-secret'`
   (`app.js`); `JWT_SECRET` falls back to `ecommerce-secret-key`; the storefront falls back to a Stripe test key
   (`src/ecommerce/routes/index.js`).
3. **A default admin password in source.** `src/auth/index.js` creates an `admin` user with a password literal. It is
   dead code (nothing requires it), but a future reader may enable it.
4. **Commerce will not start without a Stripe key.** `require('stripe')(undefined)` throws at load time. Missing
   configuration should produce a clear message, or the Stripe features should be optional.
5. **Root launcher does not start.** `app.js` requires `passport`, which is not in the root `package.json` or
   `node_modules`.

**P1**

6. **Commerce is pinned to the wrong core.** It uses `nooblyjs-core@1.0.0` from npm (method `dataServe`). The monorepo's
   core is 1.0.10 (method `dataService`). Every other accelerator uses the local core. The docs and code disagree about
   which core is correct.
7. **Commerce failing tests.** Five `SeedService` tests fail. The tests expect behaviour the service no longer has, or
   the service regressed; this needs reading both before deciding which.
8. **Commerce delivery is broken on a fresh start.** `GET /applications/delivery/api/orders` returns 500 ("Failed to
   search orders"); `analytics/overview` returns 500; the log shows `Error adding to search index` for each seeded
   product.
9. **Commerce data does not survive a restart.** Every service uses the `memory` provider. Orders, drivers and users
   created at runtime are lost.
10. **No CI in the monorepo.** Only `nooblyjs-core` has workflows. The customers coverage gate
    (`coverageThreshold`) and the infrastructure express4/express5 matrix run only when someone runs them.
11. **Infrastructure cannot yet touch a real cloud.** Roadmap items 2.8–2.10 (GCP and AWS compute adapters, real account
    connection) are unticked. The product's core promise depends on them.
12. **Customers contact centre is a status page.** Phase 3 of the roadmap is not started.
13. **Customers file data provider can read half-written files.** The README documents this; the fix (dispatch
    concurrency 1 for the file provider) is a workaround, not a fix.
14. **Empty accelerators are treated as real.** `scripts/run-all.js` picks up `analytics` and `studio` because they have
    a `package.json`. Every `run-all` command reports them.

**P2**

15. **Commerce's ecommerce routes are one 1,633-line file** (`src/ecommerce/routes/index.js`), with a product, cart,
    order, payment, admin and upload surface together.
16. **Dead and misnamed code in commerce auth.** `src/auth/index.js` (dead), and `src/auth/routes/authRoutes.js` and
    `middleware/authMiddleware.js` (unmounted, still say `blog` in their paths).
17. **Three auth mechanisms in commerce:** Passport sessions (`/api/auth`), JWT bearer tokens (ecommerce admin), and the
    core `authservice` (`src/auth/index.js`, dead). One should remain.
18. **Spec folder names differ.** Customers uses `.claude/spec/`; the others use `.claude/specs/` or `.claude/steering/`.
19. **Port defaults collide.** Commerce, customers and the root launcher all default to 3003. `run-all.js --parallel`
    assigns ports from 3001; check that the commerce and customers dev servers do not both claim 3003 when run together.
20. **Infrastructure architecture doc is a target design** in places (`src/services/engines/mongodb-vm.js`,
    `src/shared/utils/routePattern.js` do not exist). A status note was added; the rest still needs checking against the
    code.

## 3. Recommended order

1. **This week (P0):** rotate the Google client secret; remove `data/` credentials from commerce (1–3); make the Stripe
   key and JWT secret required outside development (2, 4); decide whether the root launcher is still needed (5).
2. **Next (P1):** decide the core version for commerce and migrate it (6); make the five seed tests pass or delete the
   obsolete ones (7); fix the delivery 500s (8); add one CI workflow for the monorepo (10); mark or remove the empty
   accelerators (14).
3. **Then:** the infrastructure GCP and AWS adapters (11); the commerce persistence decision (9); the customers contact
   centre (12).
4. **Cleanup (P2):** items 15–20, in the same pass as the work they touch.

## 4. Decisions needed from you

- **Commerce core:** migrate to the local core (recommended, one core across the monorepo), or keep 1.0.0 and maintain
  the commerce code against it?
- **Commerce persistence:** keep the memory provider for now, or make a persistent provider (file or MongoDB) a
  requirement before anyone relies on it?
- **Root launcher:** keep it as the single entry point that loads infrastructure, or retire it and run each accelerator
  on its own?
- **Empty accelerators:** build analytics and studio, or remove them from the monorepo until they have a spec?

## 5. What was not checked

- Commerce's seed test failures were observed, not diagnosed.
- The infrastructure express4 test run and the commerce ecommerce admin flows were not run.
- The PRDs (`.claude/specs/*` in commerce, `.claude/spec/*` in customers) describe intent; only their module structure was
  checked against code.
