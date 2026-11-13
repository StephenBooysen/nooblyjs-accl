# Spec: Noobly Cloud improvements

Status: proposed. Source: the root `.claude/specs/00-accelerator-review.md` (findings 11, 20) and `.claude/steering/roadmap.md`. The
accelerator is the most complete of the four: 120 of 120 Express 5 tests pass, the mock cloud runs the full VM lifecycle,
and operations recover after a restart. The gaps are the real clouds, the production host, and the credentials that will
live in the store once real accounts are connected.

## 1. Goal

Noobly Cloud launches and runs a real VM on GCP and on AWS through the same screens and operations that the mock uses,
with credentials that are encrypted at rest and never logged, and with a production host that does not depend on the
development sign-in.

## 2. Requirements

**R1 GCP compute adapter (roadmap 2.8).** Implement the provider contract (`src/providers/contract.js`) for GCP compute:
network `noobly-cloud`, instance, static address, firewall rules, images, machine types, data disks and resize, and
Cloud Monitoring CPU.
- The contract suite (`test/providers/contract.test.js`) runs against the GCP adapter behind an environment switch
  (`INFRA_LIVE_GCP=1`) and against the mock by default. The mock run stays in `npm test`; the live run is manual.
- Services never call the GCP SDK directly (architecture §6). Check: `grep -rn "@google-cloud" src/services src/routes` is empty.
- Acceptance (roadmap exit check for phase 2): on a sandbox GCP project, launch an Ubuntu 24.04 VM with Docker from the form,
  watch it go Starting 1→2 of 3 → Running live, SSH in, stop and start (same IP), delete. Nothing labelled
  `noobly-install` remains.

**R2 AWS compute adapter (roadmap 2.9).** The same contract for AWS: VPC, EC2, Elastic IP and public DNS name, security
group, AMIs via SSM, EBS data volumes and resize, CloudWatch CPU. Same test switch (`INFRA_LIVE_AWS=1`). Acceptance as R1
on a sandbox account.

**R3 Real account connection (roadmap 2.10).**
- GCP: service-account JSON, uploaded once and stored with the secrets service (AES-256-GCM, `src/services/secrets.js`).
- AWS: AssumeRole with an ExternalId. Store the role ARN and ExternalId; never store long-lived access keys.
- Each provider has a documented least-privilege role in `docs/` (or `.claude/steering/` if the monorepo rule in spec 01 is
  adopted), listing exactly the API permissions in R1 and R2.
- Check: the account record never contains the secret; the activity log and the scrubber (§10) hide the JSON key on error.

**R4 Production host.** `createDevLauncher()` refuses `NODE_ENV=production`. A production deployment needs a real sign-in.
- Define the host contract the launcher must implement for production (sign-in, permissions, audit, events, store, frame)
  in `architecture.md` §3, and add a test that `register()` refuses a host whose `auth` is the development one when
  `NODE_ENV=production`.
- Until the launcher has its own host, keep the refusal; do not weaken it.

**R5 Credentials never reach the logs or the browser.** Extend the test in `test/secrets.test.js` so every cloud credential
type (GCP JSON key, AWS ExternalId, database admin password, Git personal access token from phase 6) is checked against the
activity log, the operation log and the HTTP responses of every route. Acceptance: the test fails if a route returns a
credential it stores.

**R6 Webhook public URL (roadmap 6.9).** `INFRA_PUBLIC_URL` is named in the roadmap but not read by the code. Add it to
`README.md`'s configuration table when the webhook is built, and reject a missing value at start-up in production if
`hooks/git` is enabled.

**R7 Documentation matches the code.** Every item in `architecture.md` that names a file which does not exist carries a
roadmap number (done in the current status note for 5.7 and the wildcard helper). Re-check each section of
`architecture.md` against the code when a phase is ticked, and fix the doc in the same change (CLAUDE.md rule).

**R8 CI.** Run both `test:express5` and `test:express4` on every change (spec 01, R7). The express4 run is not in CI today.

## 3. Out of scope

- Phase 3 (public endpoints, Caddy, Let's Encrypt), phase 4 (buckets) and phase 5 (databases) — they have their own
  roadmap sections and need R1 and R2 first.
- Multi-cloud load balancing.

## 4. Order of work

1. R5 (credential leak test) — it guards the next two items.
2. R3 (account connection, the storage path for credentials).
3. R1 then R2 (adapters, one cloud at a time; GCP first because the roadmap lists it first).
4. R4 (production host contract) in parallel with R1.
5. R6, R7, R8.

## 5. Open questions

1. Which GCP and AWS sandbox accounts will be used for the live runs, and who owns the billing?
2. Is the production host going to be the launcher's own (recommended), or the NooblyJS AI host mentioned in the old
   `roadmap.md`?
3. Should the mock provider remain in production builds, for demonstration? (Recommended: no; gate it by
   `INFRA_PROVIDERS`.)
