# Spec: Customers accelerator improvements

Status: proposed. Source: the root `.claude/specs/00-accelerator-review.md` (findings 10, 12, 13, 18) and the roadmap in
`customer-accelerator-roadmap.md`. The accelerator is in good shape: 243 of 243 tests pass, and the demo host serves its
screens. The work below closes the gaps that remain.

## 1. Goal

Make the library safe to depend on: one CI gate, no known data-race workaround left as a footnote, and the contact centre
(Phase 3) built to the same standard as the marketing module.

## 2. Requirements

**R1 CI in this repository.** The customers accelerator is a library other applications depend on, so its checks must
run on every change.
- Add a workflow (or the monorepo one in spec 01, R7) that runs `npm ci`, `npm test`, `npm run coverage` (enforces
  `coverageThreshold` in `package.json`) on Node 22 and 24.
- Acceptance: a pull request that drops a covered line below the threshold fails.

**R2 Fix the file-provider race.** The README says the core file provider rewrites container files in place and does not
coordinate reads with writes; the workaround is `marketing.dispatch.concurrency: 1`.
- Options: (a) serialise writes per container inside the repository layer (`src/shared/repository/mutex.js` already exists
  for this purpose; extend its use to every write path); (b) forbid `file` for marketing and say so in the README.
- Recommended: (a). Acceptance: a test that runs 50 concurrent sends with the file provider reads back 50 valid
  communications and no partial JSON.

**R3 Remove the workaround text once R2 is done.** Update the README's "File data provider" paragraph.

**R4 Contact centre (Phase 3).** Build the roadmap's Phase 3 items in order: `BusinessCalendar`, `AgentService`,
`InteractionService`, `RoutingEngine`, `IssueService`, resolution capture, the public issue form (rate-limited), the SSE
stream, and the customer timeline provider. Each item has unit tests in `tests/unit/` before the route is added.
- Acceptance: the `support` module's API is documented in the README's module table, and `GET /applications/support/api/v1/health`
  returns `ok` with its own checks.

**R5 Support module admin UI.** `src/support/views` currently holds a status page. Replace it with the agent-desktop and
issue screens listed in Phase 3, or state in the README that the screens are not yet built.

**R6 Clear the old debris.**
- `customer-accelerator-architecture.md` line 61 names `examples/host-app.js` (the demo host is `test/app/index.js`) and
  line 606 names `/services/css/styles.css` (the real path is `src/shared/views/css/styles.css`). Correct both.
- Rename `.claude/spec/` to `.claude/specs/` (spec 01, R8).
- Check the `kill` script in `package.json` (`kill -9 $(lsof -t -i:3003)`): it is Unix-only; document it or replace it.

**R7 Example host in the package.** The README quick start is the only example of mounting the library. Add
`examples/host.js` (a copy of the quick start that runs), and have the README link to it. Check: `node examples/host.js`
boots and `GET /applications/customer/api/v1/health` returns `200`.

**R8 Phase 2 property test.** The roadmap exit criterion "zero sends to opted-out or suppressed recipients" has no
property-based test. Add one (for example with `fast-check` as a dev dependency) that generates random consent, suppression
and send sequences and asserts no communication with `status: sent` for an opted-out or suppressed recipient, unless the
purpose is `transactional`.

## 3. Out of scope

- Phase 4 (v1.0 hardening) and Phase 5–6 items beyond what the roadmap lists under Phase 3.
- Replacing `nodemailer` or the SMTP adapter.

## 4. Acceptance for the whole spec

- CI green on Node 22 and 24, including the coverage gate.
- The file provider passes R2's concurrency test.
- Every module in `modules` (`customer`, `marketing`, `support`) boots in the demo host with its health endpoint returning 200.
- The README reflects the code: no workaround that no longer applies, module table matches `src/`.

## 5. Open questions

1. R2: serialise writes (recommended) or forbid the file provider for marketing?
2. R4: is the contact centre needed for the next release, or can it wait behind marketing hardening?
