# Product: nooblyjs-accelerator-studio (AI Digital Studio)

Status: **specified, not built.** The folder holds the steering documents below and a `package.json` whose placeholder
`start` script points at a missing `app.js`. No source code exists yet.

## What it is

The **AI Digital Studio**: a brief-to-media production backend. A user submits a creative brief (objective, audience,
source research, brand, deliverable type) and receives a finished deliverable: **audio, image, PowerPoint** in Phase 1,
then **video, podcast** (Phase 2), then **agentic research enrichment and avatar-led media** (Phase 3). Every deliverable
passes through the same pipeline: intake → planning → generation → assembly → review → delivery.

Consumers: the internal research products that call it (a consumer-research platform as the primary consumer, and a category-management suite), through a versioned
API and n8n workflows.

## The documents (the source of truth)

| Document | Answers |
| --- | --- |
| `product-requirements.md` | What the Studio must do: six capabilities (voice, video, image, digital humans, agentic research, presentations), universal requirements, NFRs, KPIs, phases |
| `architecture-design.md` | How it is built: the six-stage pipeline, components (API gateway, job engine, queue, provider adapters, metering, asset registry, browser-control runtime), security, cost, n8n |
| `implementation-plan.md` | The phases, work breakdown, API contract sketch, test strategy, risks, definition of done |
| `studio-roles-agents-and-workflows.md` | The operating model: which agents (roles) own which pipeline stage, personas, review loops, decision authority |

Phase 1 scope is in `.claude/specs/phase-1-spine.md`.

## Decisions and known gaps (as of 13 November 2026)

1. **Business requirements:** present as `00-business-requirements.md`. The other four documents' cross-references
   (`01-…`–`04-…`) use different file names; the references should be updated to match this folder.
2. **Dates: re-planned** to a 1 February 2027 start, assumed (see `implementation-plan.md` §2). Confirm or replace the start.
3. **Code layout: decided** (confirm): built on the monorepo's `nooblyjs-core` and mounted in the launcher, like the
   infrastructure accelerator. This replaces the earlier option of a separate service.
4. **Open questions still unanswered:** PRD §8 (hosting and data residency, throughput targets, build versus buy and the
   provider shortlist, voice-cloning consent, governance of browser automation) and the roles document §9 (orchestration
   mechanism, creative-agent autonomy, persona approval). Phase 1 choices depend on them.
5. **No technology chosen yet:** `architecture-design.md` §12 lists candidates "to confirm at architecture review".

## Scope boundary

Phase 1 coding waits for gap 4 (the open questions) and gap 5 (technology). Work that does not depend on them can start now:
the canonical Brief schema, the artefact schemas in the roles document §9, and the OpenAPI draft.
