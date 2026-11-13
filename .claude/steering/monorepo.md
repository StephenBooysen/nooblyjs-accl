# Steering: the nooblyjs-accl monorepo

What is in this repository, how the parts relate, and where each part's own steering lives. Written from the source as
it is; where a doc and the code disagree, the code wins and the doc gets fixed.

## 1. The folders

| Folder | What it is | Status | Its own steering |
| --- | --- | --- | --- |
| `nooblyjs-accelerator-infrastructure` | **Noobly Cloud**: launch VMs, deploy apps from Git, databases and buckets on GCP and AWS. A hosted app loaded by the launcher at `/infrastructure`. | v0.2.0, roadmap phase 2 on the mock cloud. GCP and AWS adapters not started. | `.claude/steering/` (product, architecture, roadmap, UI mockups); `CLAUDE.md` |
| `nooblyjs-accelerator-customers` | `nooblyjs-accel-customers`: a **library** for customer data, marketing and a contact-centre status page. The host calls `mount()`. | v0.3.0, marketing MVP complete; contact centre is a status page. | `.claude/spec/` (architecture, PRD, roadmap) |
| `nooblyjs-accelerator-commerce` | Three applications in one Express server: `ecommerce`, `warehouse`, `delivery`, plus `/api/auth`. | Early build. Data in memory; some API calls fail on a fresh start; five Jest tests fail. | `.claude/steering/`, `.claude/specs/`, `.claude/learning/` |
| `nooblyjs-accelerator-analytics` | An analytics **screen**: a metrics dashboard that reads from the other accelerators. | Specified (decided 2026-11-13); no code yet. | `.claude/steering/product.md`, `.claude/specs/initial-scope.md` |
| `nooblyjs-accelerator-studio` | The AI Digital Studio: a brief-to-media production backend (audio, image, PowerPoint in Phase 1; video, podcast, agentic research, avatars later). | Fully specified by four documents; no code; several gaps (see its `product.md`). | `.claude/steering/` (4 documents), `.claude/specs/phase-1-spine.md` |
| `scripts/run-all.js` | Runs an npm script in every `nooblyjs-accelerator-*` folder that has a `package.json`. | Working. | — |
| `app.js` | The **launcher** (decided 2026-11-13: the single entry point; see `.claude/steering/launcher.md`): an Express app on `PORT` (default 3003) that loads the infrastructure accelerator at `/infrastructure`. | Does not start: `passport` is missing (see §4). | — |

## 2. How the parts relate

- **`nooblyjs-core`** is a separate repository next to this one (`../nooblyjs-core`, version 1.0.10). The launcher and
  the infrastructure and customers accelerators link it with `file:` references. It provides the service registry
  (logger, cache, dataService, queue, filing, search, notifying, working, workflow, authservice), the FsStore, the shell
  and the `/ui` kit.
- **Commerce is the exception.** Its `package.json` pins the published `nooblyjs-core@1.0.0`, which names the data
  service `dataServe`. The local core names it `dataService`. Commerce therefore does not run against the local core
  today; see `nooblyjs-accelerator-commerce/.claude/steering/architecture.md` §6.
- **The launcher** (`app.js`) is CommonJS on Express 4 and loads the infrastructure accelerator, an ES module, with a
  dynamic `import()`. It uses the infrastructure accelerator's development host (`createDevLauncher()`) until the
  launcher has its own sign-in, audit and frame. It refuses to run with `NODE_ENV=production`, by design of that host.
- **Each accelerator** is self-contained: its own `package.json`, its own tests, its own steering. The root does not
  share code between them.

## 3. Verified in this pass

- `nooblyjs-accelerator-infrastructure`: `npm run test:express5` passes 120 of 120. Port 11008 and the `INFRA_*`
  variables match the code.
- `nooblyjs-accelerator-commerce`: boots when `STRIPE_SECRET_KEY` is set; the three modules register and their screens
  return 200 at `/applications/<module>/`. `npm test` shows 5 of 15 failing.
- `nooblyjs-accelerator-customers`: `src/` has `customer`, `marketing` and `support`, matching the README.
- Root `app.js`: fails at `require('passport')` with `MODULE_NOT_FOUND`.

## 4. Open items

1. **The launcher does not start.** `passport` is required by `app.js` but is not in the root `package.json` or
   `node_modules`. Tracked as roadmap item 0.6b in the infrastructure accelerator.
2. **Commerce is on a different core.** Migrate it to the local core, or decide to keep 1.0.0 and say so everywhere.
3. **Committed secrets in commerce.** `nooblyjs-accelerator-commerce/data/google-oauth-config.json` holds a Google OAuth
   client secret and `data/users.json` a password hash. Both are tracked in git.
4. **Two accelerators have no code yet** (`analytics`, `studio`); both are specified. `scripts/run-all.js` picks them up, so
   their placeholder scripts report as no-ops until code exists.
5. **Naming:** the customers accelerator keeps its specs in `.claude/spec/`, the other projects use `.claude/specs/` or
   `.claude/steering/`. Pick one name and rename.

## 5. Where documentation goes

Each accelerator keeps its documentation under its own `.claude/` folder:

- `.claude/steering/` — what the thing is and how it is built, its roadmap and the UI it is built from.
- `.claude/specs/` (or `spec/`) — requirements and PRDs.
- `.claude/learning/` — reference material about the libraries it uses.

Two files stay at a project root because tools expect them there: `README.md` (the entry point on the forge) and
`CLAUDE.md` (read by Claude Code). Data records that an accelerator writes at runtime (for example the infrastructure
`data/infrastructure/*.md` records and their seed copies in `src/seed/data/`) are not documentation and do not move.
