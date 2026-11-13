# Spec 01: Monorepo launcher, tooling and CI

Status: proposed. Source: `00-accelerator-review.md`, findings 5, 6, 10, 14, 19.

## 1. Goal

One command from the repository root starts the accelerators that are meant to run together, runs every accelerator's
tests, and fails loudly when one breaks. Every accelerator uses the same copy of `nooblyjs-core`.

## 2. Requirements

**R1 Launcher starts.** `node app.js` at the root starts without `MODULE_NOT_FOUND`.
- Add `passport` to the root `package.json` (or remove the `require` if the launcher no longer needs it; see R5).
- Root `npm install` installs the root's dependencies, including the local core (`file:../nooblyjs-core`).
- Acceptance: `node app.js` logs `mounted … at /infrastructure` and `GET /infrastructure/api/v1/...` answers.

**R2 One core.** Every accelerator resolves `nooblyjs-core` to the local checkout (`file:../../nooblyjs-core`, or
`file:` relative to the accelerator), except where a spec says otherwise.
- Acceptance: `npm ls nooblyjs-core` in each accelerator reports the same path and version (1.0.10 today).
- Commerce is the exception now (1.0.0 from npm); its migration is in the commerce spec.

**R3 Port map.** Each accelerator has one documented default port, and the root `README.md` lists them.
- Proposed: infrastructure 11008 (standalone), customers 3003, commerce 3003, root launcher 3003 → change commerce to 3004
  and customers to 3005 when run in the launcher; or make the launcher the only one that listens.
- `scripts/run-all.js --parallel` must not start two servers on one port. Acceptance: `npm run start -- --parallel`
  starts every runnable accelerator without `EADDRINUSE`.

**R4 Test gate.** One root command runs every accelerator's tests and reports a single pass/fail.
- `npm test` at the root already runs `scripts/run-all.js test`. It must exit non-zero when any accelerator fails, and it
  must print the failing accelerator's name.
- Acceptance: with the five commerce seed tests still failing, `npm test` at the root exits non-zero and names commerce.

**R5 Launcher's role: decided (a), 2026-11-13.** The launcher stays the single entry point. Accelerators that are screens or
modules are mounted here at their own paths. Planned mounts: `/infrastructure` (now), `/analytics` (specified), then customers
and commerce once R2 and R3 are settled. Steering: `.claude/steering/launcher.md`.

**R6 Undefined accelerators.** Analytics and Studio are now specified (their `.claude/steering/` and `.claude/specs/` folders).
Each needs a `README.md` at its root, and its `test` script must run real tests once code exists (today both use
`--passWithNoTests`, which hides a missing suite). Studio's `start` script points at a missing `app.js`; fix it when
its code layout is decided (its steering, gap 5).
- Acceptance: `scripts/run-all.js` output reports each accelerator's real status, and no `start` script points at a missing file.

**R7 CI.** Add `.github/workflows/ci.yml` at the root:
- Node 22 (matches infrastructure's `engines` and customers' `engines`) and Node 24 (matches the installed runtime).
- Steps: `npm install` at the root; `npm test` (R4); `npm run coverage` in the customers accelerator, which enforces its
  `coverageThreshold`; infrastructure `npm run test:express4` and `test:express5`.
- Required before merge to `main`.
- Acceptance: a pull request that breaks a test fails the check.

**R8 Spec folder names.** Standardise on `.claude/steering/` (what it is, how it is built) and `.claude/specs/`
(requirements). Rename customers' `.claude/spec/` to `.claude/specs/`. Update its internal links.

## 3. Out of scope

- Publishing any accelerator to npm.
- Changing the infrastructure accelerator's runtime.

## 4. Open questions

1. R5: decided (a).
2. R6: analytics and studio are now defined (see their steering folders), so they are no longer placeholders. Remove the R6 placeholder requirement.
3. R3: which accelerator should own port 3003?

## 5. Verification steps for the implementer

```bash
cd /workspaces/codespaces-blank/nooblyjs-accl
npm install
node app.js                      # R1
npm ls nooblyjs-core             # R2, run in each accelerator
node scripts/run-all.js start --parallel   # R3
npm test; echo "exit $?"        # R4
```
