# Steering: the root launcher (`app.js`)

Status: **does not start.** It exits with `Cannot find module 'passport'`. Fix tracked in `.claude/specs/01-monorepo-launcher.md`
(R1) and in the infrastructure roadmap item 0.6b.

## Purpose

One Express app that mounts the accelerators that are meant to run together. Today it mounts one: the infrastructure
accelerator (Noobly Cloud) at `/infrastructure`.

## How it works (as written in the code)

1. Creates an Express app, parses JSON and form bodies, and initialises `nooblyjs-core` with a shared `EventEmitter`.
2. Asks core for the default services (logger, cache, dataService, queue, scheduling, searching, measuring, notifying,
   working, workflow, filing), all on their `memory` or `local` providers.
3. Imports the infrastructure accelerator as an ES module, creates its development host (`createDevLauncher()`), and
   calls its `register()` with the data directory `.application/data/infrastructure`.
4. Listens on `PORT` (default 3003).

## Rules

- The launcher is CommonJS on Express 4. Accelerators that are ES modules are loaded with a dynamic `import()`.
- The development host signs anyone in and refuses `NODE_ENV=production`. The launcher must not be deployed to production
  until it has its own host (infrastructure architecture §3).
- Services are created once here and shared through the core registry; accelerators must not create their own copies of
  core services for the same purpose.

## Known gaps

- `passport` is required but not installed (spec 01, R1).
- Only one accelerator is mounted. Customers and commerce are not wired in.
- The root `package.json` depends on `nooblyjs-core` via `file:../../nooblyjs-core`; this path is only valid from inside
  the monorepo layout.
- The default port (3003) is shared with commerce and customers (spec 01, R3).

## Decision (2026-11-13)

The launcher **stays the single entry point** (spec 01, R5, option a). Accelerators that are screens or modules are mounted
here, each at its own path, into the frame. Adding an accelerator means: its `register()` or `mount()` call in `app.js`, a
mount path, and one entry in the frame's navigation.

Planned mounts, in the order they are ready: `/infrastructure` (mounted now), `/analytics` (screen, specified), then the
customers and commerce accelerators once their ports and core versions are settled (spec 01, R2 and R3).
