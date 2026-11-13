# Implementation Plan

**Product:** AI Digital Studio — Brief-to-Media Generation (Video · Image · Audio · Podcast · PPTX)
**Derived from:** `00-business-requirements.md`, `01-product-requirements.md`, `02-architecture-design.md`
**Owner:** [to be assigned]
**Status:** Draft v1.0

---

## 1. Approach

Deliver the AI Digital Studio in four phases, each producing **more deliverable types the Studio can generate end-to-end from a brief**. Phase 1 stands up the **production-pipeline spine** (brief intake → planning → generation → review/approval → delivery) plus the supporting orchestration (provider abstraction, job engine, callbacks, n8n, cost/telemetry), and lands the first, lowest-risk deliverables (**Audio**, **Image**, and draft **PowerPoint**). Later phases add richer deliverables (video, full presentations, podcasts), then agentic enrichment and avatar-led media, and finally enterprise scale and governance.

Cross-cutting concerns (pipeline spine, security, observability, cost metering, provider abstraction) are built **first** and reused by every deliverable type, avoiding rework.

---

## 2. Phased Roadmap, Milestones & Indicative Timeline

> **Timeline assumptions (re-planned 13 November 2026).** The windows below are planning assumptions. They assume: a **single
> cross-functional squad of 6–8 engineers** (backend, ML/integration, DevOps, QA) plus a part-time architect and product owner;
> **the open decisions in `product.md` (gaps 2–5) closed before the start date**; **provider accounts and budget ceilings
> approved before Phase 1**; **two-week sprints**; and an **assumed start of Monday 1 February 2027**. The original start
> (5 January 2026) has passed. Change the start date and every window shifts with it; durations do not change.

| Phase | Theme | Deliverable types unlocked | Indicative duration | Indicative window (assumed) | Exit Milestone |
|-------|-------|----------------------------|---------------------|-----------------------------|----------------|
| **P1** | Studio foundation (pipeline spine) | **Audio (C1)** + **Image (C3)** + draft **PPTX (C6)** | **~10 weeks (5 sprints)** | 01 Feb – 09 Apr 2027 | M1: Submit a brief → receive an audio summary, image set, or draft deck via API + n8n, with review gate, cost metering & callbacks |
| **P2** | Rich media | **Video (C2)** + full **PowerPoint (C6)** + **Podcast (multi-voice C1)** | **~12 weeks (6 sprints)** | 12 Apr – 02 Jul 2027 | M2: Brief → multi-scene brand-consistent video; full editable storytelling deck; multi-voice podcast |
| **P3** | Interactive & enriched | **Agentic research enrichment (C5)** + **avatar-led (C4)** + real-time voice | **~12 weeks (6 sprints)** | 05 Jul – 24 Sep 2027 | M3: Brief → deliverable enriched with cited sources (secure login); avatar-presented video; real-time avatar+voice session |
| **P4** | Scale & govern | (hardening across all deliverable types) | **~8 weeks (4 sprints)** | 27 Sep – 19 Nov 2027 | M4: Load-tested to target concurrency; budgets/approval enforced; provider swap demonstrated |

**Indicative end-to-end:** ~**42 weeks (~9.5 months)** from the assumed start: a first briefable Studio (M1) by **early April 2027** and a fully governed Studio (M4) by **mid-November 2027**, subject to the assumptions above.

*(Durations assume the team/scope above; sequencing and dependencies in §3 drive the plan regardless of absolute dates.)*

---

## 3. Work Breakdown Structure (WBS)

### Phase 1 — Studio foundation (pipeline spine + Audio + Image + draft PPTX)
0. **Studio pipeline spine**: canonical **Brief** intake/validation; **Creative planning** stage (script/plan generation); **Review & approval** gate with versioning; **Delivery** step — the brief→media backbone every deliverable reuses.
1. **Project scaffolding & environments** (dev/test/prod), CI/CD, IaC baseline.
2. **API Gateway** (REST + health), OpenAPI spec, versioning (`/v1`).
3. **AuthN/AuthZ**: OIDC for users, client-credentials for services (consuming products, n8n), scoped API keys, rate limiting.
4. **Job Engine**: submit/status endpoints, idempotency keys, lifecycle state machine, retries/backoff, DLQ.
5. **Queue/broker** with per-modality topics.
6. **Provider Adapter Layer** + **Capability Registry** (selection policy: default/premium/cost/AB) + `FeatureMatrix`.
7. **Callback/Webhook Service**: signed payloads, retry delivery.
8. **Cost & Usage Metering** + **Budgets** (estimateCost hook, usage records, soft/hard limits, reports).
9. **Asset/Identity Registry** (personas, visual identities, asset provenance + usage rights).
10. **Object storage + metadata DB + Vault** integration.
11. **Observability** (structured logs, metrics, tracing per job/provider).
12. **Image Worker + ≥1 Image adapter** (C3): seed image, style, text-rendering-capable provider.
13. **Voice Worker + ≥1 Voice adapter** (C1 batch): TTS/STT, prosody controls, persona persistence.
14. **n8n node package (Studio)**: image + voice operations, wait-for-webhook pattern.
15. **Docs**: API reference, integration guide, runbook.

### Phase 2 — Multimedia (Video + Presentations)
1. **Video Worker + adapter(s)** (C2): text/image/storyboard-to-video; project→scene→shot model; first/last-frame, camera, character/asset seeding via Identity Registry; render tiers.
2. **Audio compositing**: integrate C1 narration/dialogue into video.
3. **GPU worker pool** provisioning + concurrency caps.
4. **Presentation Worker** (C6): narrative/structure generator (LLM) → deterministic **editable PPTX** renderer; brand templates; chart-selection module; infographic component library; image integration via C3.
5. Extend **n8n node** with video + presentation operations.
6. Progress-event streaming for long jobs.

### Phase 3 — Interactive & Agentic (Agentic browser-control + Avatars + Real-time voice)
1. **Browser-Control Runtime** (C5): sandboxed ephemeral browser pods; planner–executor loop; tool set (navigate/click/type/scroll/extract); step budget/timeouts.
2. **Credential Broker**: vault fetch, runtime injection, secret scrubbing from logs/outputs; per-site scoping/consent.
3. **Robustness**: pop-up/consent-banner handling, retries, pluggable challenge strategies, human-escalation path.
4. **Citation Recorder**: url + timestamp + snapshot per claim → structured report generator.
5. **Egress control & audit** for agentic runs; ToS/robots policy config.
6. **Realtime Session Service** (WS/WebRTC): real-time voice (C1) and **avatars** (C4); webcam ingest; RAG grounding against internal data stores; persona reuse; low-latency media routing.
7. Extend **n8n node** with agentic-research operation.

### Phase 4 — Scale & Govern
1. **Load & soak testing** to target concurrency; autoscaling policies per worker pool.
2. **Provider A/B & swap** demonstration (zero consumer contract change); circuit breakers/fallbacks.
3. **Advanced cost governance**: dashboards, per-consumer/workflow reports, tiered-rate analysis.
4. **Security hardening & pen test**; data-retention/residency enforcement; DR/backup.
5. **SLOs/alerting**, on-call runbooks, capacity plan.

---

## 4. API Contract (illustrative `/v1`)

```
POST /v1/{capability}              # capability ∈ image|voice|video|presentation|agentic
  body: { input, controls, providerPolicy?, callbackUrl?, idempotencyKey? }
  201 → { jobId, status:"queued", estimatedCost }

GET  /v1/jobs/{jobId}              → { jobId, status, result?, cost, providerId, error? }
GET  /v1/jobs/{jobId}/assets       → [{ assetId, uri, mediaType, usageRights }]

POST /v1/personas                  # create/register voice or avatar persona (with consent meta)
GET  /v1/personas/{id}
POST /v1/identities                # visual identity (character/brand/product/env)

POST /v1/agentic/run               # { task, target, credentialScope?, callbackUrl? }
GET  /v1/agentic/{runId}           → { status, report, citations[] }

WS   /v1/realtime/{voice|avatar}   # bidirectional media session (persona, RAG grounding)

GET  /v1/usage?scope=&from=&to=    # consumption reports
POST /v1/budgets                   # spend limits (soft/hard)

# Webhook (platform → consumer)
POST {callbackUrl}                 # signed: { jobId, status, assets[], cost }
```

Canonical request `controls` are validated against the selected provider's `FeatureMatrix`; unsupported controls are rejected or degraded per policy (see Architecture §4).

---

## 5. Environment & Infrastructure

- **Environments:** dev → test/staging → prod, provisioned via IaC.
- **Runtime:** containers on an autoscaling orchestrator (Kubernetes-class); separate node/worker pools: API (CPU), image/voice (CPU), video (GPU), browser-control (isolated sandbox pods), realtime (low-latency).
- **Data:** object storage (assets/snapshots), relational metadata DB (jobs/personas/usage), enterprise vault (secrets), read-only connectors to internal data stores for RAG.
- **Networking:** egress allow-lists for agentic runtime; TLS everywhere; private networking between tiers.
- **CI/CD:** build/test/scan pipeline, IaC apply, blue/green or canary for API tier.

---

## 6. Testing Strategy

| Level | Coverage |
|-------|----------|
| **Unit** | Adapters (canonical↔provider mapping), job state machine, cost estimation, credential scrubbing |
| **Contract** | Canonical API contracts; provider adapter conformance against `FeatureMatrix` |
| **Integration** | End-to-end job (submit→queue→worker→provider mock→callback); n8n workflow round-trip |
| **Provider sandbox** | Real provider calls in test accounts (cost-capped) for each capability |
| **Agentic** | Deterministic test sites; credential-scrubbing assertions (no secrets in logs/outputs); citation-traceability checks |
| **Realtime** | Latency/turn-taking measurement vs NFR-1; session stability |
| **Load/soak** | Target concurrency (NFR-2); back-pressure; queue drain; GPU pool saturation |
| **Security** | Auth/scopes, secret handling, egress control, pen test (P4) |
| **Quality gates** | Human review rubric for "client-ready with minimal post-production" (KPI) |

**Verification note:** each capability's exit criteria in §2/§3 must pass its integration + provider-sandbox tests before the phase milestone is signed off.

---

## 7. Cross-Cutting Deliverables

- **Security & governance:** vaulting, no-secrets-in-logs enforcement, audit trail, consent metadata for voice/avatar, agentic ToS policy.
- **Cost control:** estimateCost, metering, budgets (soft/hard), consumption reports.
- **Observability:** dashboards + alerts per job/provider; cost and error-rate SLOs.
- **Documentation:** OpenAPI reference, per-capability integration guides, n8n node docs, operational runbooks.

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Provider capability gaps (control coverage varies) | Feature requests unmet | `FeatureMatrix` + policy-driven routing/degradation; multi-provider per capability |
| Agentic reliability & anti-bot challenges | Failed/blocked runs | Robustness hooks, retries, human-escalation, deterministic test suite |
| Credential leakage in agentic runs | Security breach | Vault + runtime injection + scrubbing + audit; isolation between runs |
| Cost overruns (premium providers) | Budget breach | estimateCost pre-flight, hard budget limits, per-consumer policy |
| Real-time latency targets (avatars) | Poor UX | Dedicated realtime tier, edge/media routing, provider selection by latency class |
| Legal: voice cloning / avatar likeness / site ToS | Compliance exposure | Consent metadata, usage-rights provenance, per-site policy config, legal sign-off |
| Vendor lock-in | Reduced agility | Provider abstraction + swap demonstrated in P4 |
| n8n community-node maturity | Integration fragility | Own Studio n8n node fronting the platform as stable surface |

---

## 9. Dependencies & Prerequisites

- Approved provider shortlist + budget ceilings per capability (PRD §8 Open Q3).
- Hosting/cloud + data-residency decision (Open Q1).
- Concurrency/throughput targets from the consuming products (Open Q2).
- Consent/legal framework for cloning/likeness (Open Q4) and agentic automation governance (Open Q5).
- Access to internal data stores (RAG) and brand asset library.
- Vault, IdP, and enterprise observability stack availability.

---

## 10. Definition of Done (per capability)

1. Canonical API endpoint + ≥1 provider adapter passing contract + sandbox tests.
2. Job lifecycle, callbacks, and cost metering working end-to-end.
3. n8n operation available and round-trip tested.
4. Security controls verified (auth scopes; secrets never logged; audit entries present).
5. Quality gate passed (human-review rubric where applicable).
6. Docs (API + integration guide) published.

---

## 11. Handover to architecture review

This plan, with the PRD and Architecture & Design documents, presents the **AI Digital Studio** solution (the brief-to-media production pipeline), its architecture, and an indicative delivery timeline. As a supporting concern it also addresses the BRD's capability-assessment request: internal/external provider identification (via the provider-abstraction shortlist kept swappable behind the Studio), architectural fit and governance, preferred provider options and trade-offs, and cost/scalability/sustainability. Final provider selections, budget ceilings, and confirmation of the timeline assumptions in §2 are architecture review decisions captured as the open questions above.
