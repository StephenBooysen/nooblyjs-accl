# Spec: Studio Phase 1 — pipeline spine, Audio, Image, draft PowerPoint

Status: **proposed; blocked on the open questions and technology choice in `.claude/steering/product.md` (gaps 4 and 5).** Source:
`.claude/steering/implementation-plan.md` §3 Phase 1 (items 0–15), `architecture-design.md`, `product-requirements.md` §9.

## 1. Goal

A brief goes in through the API; an audio summary, an image set or a draft deck comes out, through the six-stage pipeline,
with a review gate, cost metering and a signed callback. Every later deliverable reuses this spine.

Exit milestone M1 (from the plan): *submit a brief → receive an audio summary, image set, or draft deck via API and n8n,
with review gate, cost metering and callbacks.*

## 2. Requirements

Numbers follow the implementation plan's Phase 1 list.

**R0 Pipeline spine.** The six stages from `architecture-design.md` §0 (intake, planning, generation, assembly, review,
delivery) exist as steps of one job. Each step writes its artefact and a status record.
- Acceptance: a job with a stub generator passes all six stages and the status history shows each one.

**R1 Project scaffolding.** Dev, test and production configuration; CI running unit tests on every change; an
infrastructure-as-code baseline is recorded (choice deferred to the open decisions).
- Acceptance: `npm test` and the CI check pass on a clean checkout.

**R2 API gateway.** REST under `/v1`, `GET /health`, and an OpenAPI document generated from code.
- Acceptance: the OpenAPI document lists every route in §4; `GET /v1/health` returns 200.

**R3 Authentication and authorisation.** OIDC for people; client credentials for services (the consuming products, n8n); scoped API
keys; per-client rate limits.
- Acceptance: a request without a token returns 401; a token without the scope returns 403; the rate limit returns 429.

**R4 Job engine.** Submit and status endpoints; an idempotency key on submit (the same key returns the same job); lifecycle
`queued → running → succeeded | failed`; retries with backoff; a dead-letter record after the last retry.
- Acceptance: a repeated submit with one key creates one job; a job that fails three times lands in the dead-letter list.

**R5 Queue with per-modality topics.** One topic per deliverable type (audio, image, deck) so workers scale separately.
- Acceptance: a worker subscribed to `image` never receives an `audio` job.

**R6 Provider adapter layer and capability registry.** One adapter interface per capability; a registry picks a provider by
policy (default, premium, cost-optimised) per consumer; a feature matrix records what each provider supports.
- Acceptance: switching a consumer's policy changes the adapter used, with no change to the consumer's request.

**R7 Callbacks.** On completion or failure, a signed webhook is sent to the consumer, with retries and backoff.
- Acceptance: the signature verifies with the consumer's secret; a receiver that returns 500 gets the callback again.

**R8 Cost and usage metering.** Per job: provider unit costs recorded; soft and hard budgets per consumer; a usage report by
capability, product and workflow.
- Acceptance: a job that would exceed the hard budget is refused before generation starts; the report totals match the
  recorded usage.

**R9 Asset and identity registry.** Persist personas (voice), visual identities, seed images and generated-asset metadata,
including a commercial-usage-rights flag per asset.
- Acceptance: a persona saved in one job is reusable in a second job with the same identity.

**R10 Storage.** Object storage for assets; a relational store for job and asset metadata; secrets from the enterprise vault.
- Acceptance: no provider key appears in the job record or any log line.

**R11 Observability.** Structured logs, metrics and a trace per job and per provider call.
- Acceptance: one job ID appears in its logs, its metrics and its trace.

**R12 Image worker and one image adapter (C3).** Seed image, style control, text rendering.
- Acceptance: an image job returns the image set and its usage-rights flag.

**R13 Voice worker and one voice adapter (C1 batch).** Text to speech, prosody controls, persona persistence.
- Acceptance: an audio job returns the audio file; a second job with the same persona sounds consistent (verified by listening
  and recorded in the review, since no automated check exists for this).

**R14 n8n node package.** Image and voice operations; a "wait for webhook" pattern.
- Acceptance: an n8n workflow submits a brief and continues when the callback arrives.

**R15 Documentation.** API reference, an integration guide and a runbook, generated or written from the code.

**Draft PowerPoint (C6, part of Phase 1).** Generate an editable draft deck from a plan.
- Acceptance: the deck opens in PowerPoint and every slide is editable (a file check, not a visual one).

## 3. Review gate

Every job stops at stage 5 until a person approves or requests changes. Changes create a new version, and the job is
charged against its budget. The gate is enforced by the job engine, not by the client.

## 4. API (Phase 1 subset)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/jobs` | Submit a brief (requires `Idempotency-Key`) |
| `GET` | `/v1/jobs/{id}` | Status and history |
| `POST` | `/v1/jobs/{id}/reviews` | Approve or request changes |
| `GET` | `/v1/jobs/{id}/assets` | Generated assets with usage rights |
| `GET`/`POST` | `/v1/personas` | Reusable voice and visual identities |
| `GET` | `/v1/usage` | Consumption report |
| `GET` | `/v1/health` | Liveness |

## 5. Out of scope for Phase 1

Video, full PowerPoint storytelling, podcasts, agentic research, avatars, real-time voice. (Phases 2 and 3.)

## 6. Blocking decisions

From `.claude/steering/product.md`:
1. **Start date:** confirm the 1 February 2027 assumption (gap 2).
2. **Open questions** in PRD §8 and roles §9 (gap 4). At minimum: hosting and data residency, the approved provider shortlist,
   and budget ceilings (they set R6 and R8).
3. **Technology** for the API framework, queue, storage and PPTX engine (gap 5).
4. **Code layout** is decided: on `nooblyjs-core`, mounted in the launcher (gap 3, to confirm).

Work that does not depend on these can start now: the canonical Brief and artefact schemas (roles §9) and the OpenAPI draft.

## 7. Definition of done (from the plan §10, applied to Phase 1)

- Every requirement above has an automated test, except R13's listening check, which is recorded.
- Each deliverable (audio, image, deck) runs end to end in the staging environment.
- The runbook exists and was used once to restart a stuck job.
