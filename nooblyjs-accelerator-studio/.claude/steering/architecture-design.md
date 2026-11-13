# Architecture & Design Document

**Product:** AI Digital Studio — Brief-to-Media Generation (Video · Image · Audio · Podcast · PPTX)
**Derived from:** `00-business-requirements.md`, `01-product-requirements.md`
**Owner:** [to be assigned]
**Status:** Draft v1.0

---

## 0. The Studio Production Pipeline (architecture lead)

The architecture exists to deliver one thing: **brief in → media out**. Everything below is organised around a six-stage production pipeline. Each stage has clear inputs, outputs, and a hand-off; the orchestration spine and provider-abstraction layer (Sections 3–4) are the **supporting substrate** that makes the pipeline run.

```
   BRIEF ──▶  [1] BRIEF INTAKE ──▶ [2] CREATIVE PLANNING ──▶ [3] GENERATION ──▶ [4] ASSEMBLY ──▶ [5] REVIEW & QA ──▶ [6] DELIVERY ──▶ MEDIA
              normalise &          storyline / script /       produce raw       compose/edit      quality gate +      final render,
              validate the         scene or slide plan;       media per          into the         human approval;     register asset +
              canonical Brief      pick identities;           modality           deliverable      version + loop      usage rights;
              (objective,          gather cited evidence      (voice/image/      (cut/mix/deck)    under budget cap    callback
              audience, source,    (optional C5)              video/avatar/                                            
              brand, type)                                    slides)                                                  
```

| Stage | Input | Output (artefact) | Backed by (Sections 3–5) |
|-------|-------|-------------------|--------------------------|
| 1. Brief intake | Raw brief | Canonical **Brief** | API Gateway + Capability Router (normalisation) |
| 2. Creative planning | Brief (+ RAG, +C5 evidence) | **Script / Storyboard / Slide plan**, bound identities | LLM planning, Asset/Identity Registry, Agentic runtime (C5) |
| 3. Generation | Plan + identities | Raw media parts | Modality Workers + Provider Adapters (C1–C4, C6) |
| 4. Assembly | Raw parts | Draft deliverable | Assembly/compositing (video cut, audio mix, PPTX build) |
| 5. Review & QA | Draft deliverable | Approved version | Quality gate + Callback/Webhook + audit trail |
| 6. Delivery | Approved version | Final **Asset** + rights | Object storage, Asset registry, Callback |

The stage-by-stage operating model (which agent owns which stage, gates, review loops) is in `04-studio-roles-agents-and-workflows.md`. The remainder of this document specifies the technical substrate that executes the pipeline.

---

## 1. Architectural Goals & Principles

| Principle | Rationale |
|-----------|-----------|
| **Pipeline-first** | The system is a brief→media production pipeline; components serve pipeline stages. |
| **API-first** | Every stage/control available programmatically (U-API1..3). |
| **Async by default** | Generation is long-running → job queue + callbacks (U-INT2/3). |
| **Governed review** | Review/approval and versioning are first-class pipeline steps (NFR-6). |
| **Provider abstraction (supporting)** | Decouple the pipeline from vendors → provider swap-ability, A/B, future-proofing (NFR-8). |
| **n8n-native** | First-class automation surface for submitting briefs (U-N8N1). |
| **Secure by design** | Vaulted credentials, no secrets in logs, full audit (NFR-5/6). |
| **Observable & cost-aware** | Per-job/per-provider telemetry and spend tracking (U-CC1..3, NFR-9). |
| **Horizontally scalable** | Stateless API + scalable workers per modality (U-SC1/2, NFR-2). |

**Style:** Modular service (or well-bounded modular monolith at Phase 1) implementing the production pipeline via a **capability gateway** (brief intake/normalisation), a **planning stage**, an **async job engine** driving specialised **modality workers** (generation), **assembly** services, and **review/delivery** — all sitting on a **normalised provider-adapter layer** with a dedicated, isolated **browser-control runtime** for agentic evidence-gathering.

---

## 2. System Context (C4 — Level 1)

```
                        ┌─────────────────────────────────────────────┐
   App A ──────────────▶│                                             │
   App B ──────────────▶│           AI Digital Studio                 │◀──── n8n workflows
   n8n ────────────────▶│   (Brief → Media production pipeline;       │
   Research Producers ─▶│    orchestration + provider adapters)       │
      (submit brief)    └───────────────┬─────────────────────────────┘
                                         │  brief → media
             ┌───────────────┬───────────┼───────────────┬─────────────────┐
             ▼               ▼           ▼               ▼                 ▼
        Voice Providers  Video Prov.  Image Prov.  Avatar Providers   External Web / Gated Systems
        (TTS/STT/RT)     (gen/render) (gen)        (real-time DH)     (via Browser-Control runtime)
             │               │           │               │                 │
             └───────────────┴───────────┴───────────────┴─────────────────┘
                                         │
                        Secrets Vault · Object Storage · IdP · Observability · Internal Data Stores (RAG)
```

---

## 3. Container / Component View (C4 — Level 2)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Orchestration Layer                                │
│                                                                             │
│  ┌───────────────┐   ┌──────────────────┐   ┌────────────────────────────┐ │
│  │ API Gateway   │   │ Capability Router │   │ AuthN/AuthZ (OIDC + API keys)│ │
│  │ (REST + WS)   │──▶│  + Request Norm.  │──▶│  + Rate limiting / quotas    │ │
│  └───────────────┘   └───────┬──────────┘   └────────────────────────────┘ │
│                              │                                              │
│                    ┌─────────▼──────────┐     ┌───────────────────────────┐ │
│                    │  Job Engine        │────▶│ Queue (broker)            │ │
│                    │  (submit/status/   │     │  per-modality topics      │ │
│                    │   idempotency)     │     └───────────┬───────────────┘ │
│                    └─────────┬──────────┘                 │                 │
│                              │                            │                 │
│              ┌───────────────┼────────────────────────────┼──────────────┐  │
│              ▼               ▼                            ▼               │  │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │  │
│   │ Voice Worker │ │ Image Worker │ │ Video Worker │ │ Presentation   │  │  │
│   │              │ │              │ │              │ │ Worker (PPTX)  │  │  │
│   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └───────┬────────┘  │  │
│          │                │                │                 │           │  │
│   ┌──────▼────────────────▼────────────────▼─────────────────▼────────┐  │  │
│   │              Provider Adapter Layer (normalised interfaces)        │  │  │
│   │   VoiceAdapter · ImageAdapter · VideoAdapter · AvatarAdapter ·     │  │  │
│   │   PresentationAdapter · AgenticAdapter   (+ capability registry)   │  │  │
│   └───────────────────────────────────────────────────────────────────┘  │  │
│                                                                          │  │
│   ┌──────────────────────────┐   ┌───────────────────────────────────┐  │  │
│   │ Realtime Session Service │   │ Agentic / Browser-Control Runtime │  │  │
│   │ (WS/WebRTC: voice+avatar)│   │ (isolated headless browsers,      │  │  │
│   └──────────────────────────┘   │  planner, tools, credential broker)│  │  │
│                                   └───────────────────────────────────┘  │  │
│                                                                          │  │
│   ┌──────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ │  │
│   │ Callback/    │ │ Cost & Usage  │ │ Asset/Identity│ │ Observability│ │  │
│   │ Webhook Svc  │ │ Metering Svc  │ │ Registry      │ │ (logs/traces)│ │  │
│   └──────────────┘ └───────────────┘ └───────────────┘ └──────────────┘ │  │
└───────────────────────────────────────────────────────────────────────────┘
        │                 │                    │                 │
   Object Storage    Metadata DB          Secrets Vault      Internal Data Stores
   (assets/outputs)  (jobs/personas)      (provider keys /   (RAG grounding)
                                           user creds)
```

### 3.1 Core Components

- **API Gateway (REST + WebSocket):** single entry; REST for async jobs, WebSocket/WebRTC for real-time (voice, avatars). Enforces auth, rate limits, quotas.
- **Capability Router + Request Normaliser:** validates and normalises capability requests into a canonical schema, independent of provider.
- **Job Engine:** accepts submissions, assigns idempotency keys, tracks lifecycle (`queued → running → succeeded/failed`), exposes status polling and drives callbacks.
- **Queue/Broker:** per-modality topics so workers scale independently (e.g., video needs GPU-heavy long jobs; image is shorter).
- **Modality Workers:** stateless consumers that pull jobs and invoke the appropriate provider adapter; handle retries, chunking, and progress events.
- **Provider Adapter Layer:** the core of vendor abstraction — one normalised interface per capability, many provider implementations, selected via a **Capability Registry** (policy: default/premium/cost-optimised, per consumer).
- **Realtime Session Service:** manages low-latency bidirectional streams for Capability 1 (real-time voice) and Capability 4 (avatars), bridging client media to provider streaming APIs.
- **Agentic / Browser-Control Runtime:** isolated, sandboxed headless-browser execution environment with an agent planner, tool set (navigate, click, type, extract, solve-challenge hooks), a **credential broker** (fetches secrets from vault, injects at runtime, never returns them to callers), and a **citation recorder**.
- **Callback/Webhook Service:** signed webhooks on job completion/failure; delivery retries with backoff.
- **Cost & Usage Metering Service:** records provider unit costs per job; enforces budgets/spend limits; emits consumption reports (U-CC1..3).
- **Asset/Identity Registry:** persists reusable **personas** (voice/avatar), **visual identities** (character/brand/product), seed images, and generated-asset metadata including **commercial-usage-rights** flags — this is how identity persistence (NFR + BRD criterion) is delivered across providers.
- **Observability:** structured logs, metrics, distributed tracing per job and per provider call.

---

## 4. Provider Abstraction Design (supporting substrate — enables provider swap & future-proofing)

Provider abstraction is what lets the Studio's brief-to-media pipeline stay stable while the underlying generation providers change. Each generation ability defines a **canonical request/response contract**. Adapters translate canonical ↔ provider-specific.

```
CapabilityRequest (canonical)
        │
        ▼
Capability Registry ── selects ──▶ Provider policy
        │                          (default | premium | cost | AB-test | per-consumer override)
        ▼
ProviderAdapter.execute(canonical) ──▶ provider SDK/HTTP ──▶ normalise result ──▶ CanonicalResult
```

**Interface sketch (illustrative):**

```ts
interface ProviderAdapter<TReq, TRes> {
  readonly capability: Capability;        // voice | image | video | avatar | presentation | agentic
  readonly providerId: string;            // e.g. "provider-a"
  capabilities(): FeatureMatrix;          // which controls this provider supports
  estimateCost(req: TReq): CostEstimate;
  execute(req: TReq, ctx: JobContext): Promise<TRes>;   // async job body
  // realtime adapters additionally expose openSession(): RealtimeSession
}
```

**Feature matrix / graceful degradation:** because providers vary (e.g., not all support last-frame control or accent control), each adapter declares a `FeatureMatrix`. The router can (a) reject unsupported controls, (b) route to a capable provider, or (c) degrade with a warning — policy-driven per consumer.

**Selection policy inputs:** requested feature set, cost ceiling, latency class (real-time vs batch), consumer (the premium consumer product may default to premium), and A/B experiment assignment.

---

## 5. Capability-Specific Design Notes

### 5.1 AI Voice (Cap 1)
- Batch (TTS/STT) via job engine; **real-time** conversation via Realtime Session Service (WebRTC/WS).
- Persona persistence via Identity Registry (voice IDs, cloning artefacts with consent metadata).
- Canonical controls: emotion, style, pacing, emphasis, accent, multi-speaker.

### 5.2 AI Video (Cap 2)
- Long-running GPU jobs; dedicated worker pool + queue topic; progress events.
- Storyboard model: a **project → scenes → shots** structure with first/last-frame, camera, character refs, and asset-seeding pulled from Identity Registry to enforce continuity.
- Audio integration composes Capability 1 outputs (narration/dialogue) with generated video.

### 5.3 AI Image (Cap 3) — *Phase 1 anchor*
- Shorter jobs; seed-image + style-reference support; text-rendering-capable providers preferred.
- Outputs registered with usage-rights metadata; reusable as seeds for video/presentation.

### 5.4 Digital Humans & Avatars (Cap 4)
- Real-time audio-visual via Realtime Session Service; webcam ingest; **RAG grounding** hook against internal data stores; persona reuse via Identity Registry.
- Highest latency sensitivity (NFR-1); co-located/edge media routing considered.

### 5.5 Agentic Research & Browser-Control (Cap 5) — *platform namesake*
- **Isolated runtime:** each agent run in a sandboxed, ephemeral browser context (container/pod), network-egress controlled and audited.
- **Planner–executor loop:** LLM planner → browser tools (navigate/click/type/scroll/extract) → observation → re-plan; step budget + timeouts for reliability/reproducibility.
- **Credential broker:** secrets fetched from vault at runtime, injected into the browser session, scrubbed from all logs/outputs (NFR-5). Per-site credential scoping and consent.
- **Robustness hooks:** pop-up/consent-banner dismissal, retry/backoff, and pluggable challenge-handling strategies; escalate-to-human when blocked.
- **Citation recorder:** every extracted fact linked to URL + timestamp + DOM snapshot/screenshot → produces the traceable structured report (P-AR3/4).
- **Governance:** respect target-site ToS/robots policy per configuration; full action audit trail (NFR-6).

### 5.6 Presentations & Data Storytelling (Cap 6)
- Two-stage: **narrative/structure generation** (LLM) → **deterministic PPTX rendering** (e.g., OOXML/`python-pptx`-style engine) for genuinely editable output (P-PR1).
- Brand-compliant templates from the brand asset library; charts via a chart-selection module; imagery via Capability 3; infographic component library.

---

## 6. Data Model (logical)

| Entity | Key fields | Notes |
|--------|-----------|-------|
| **Job** | id, capability, providerId, consumer, status, idempotencyKey, cost, timestamps, callbackUrl | Central async unit |
| **Persona** | id, type(voice/avatar), providerRefs, consentMeta | Identity persistence |
| **VisualIdentity** | id, type(character/brand/product/env), seedRefs, styleRefs | Cross-scene consistency |
| **Asset** | id, jobId, storageUri, mediaType, usageRights, provenance | Generated outputs |
| **AgentRun** | id, plan, steps[], citations[], credentialsScope, auditLog | Cap 5 runs |
| **Citation** | id, agentRunId, url, timestamp, snapshotUri, claimRef | Traceability |
| **UsageRecord** | id, jobId, providerId, units, cost, consumer, budgetRef | Cost metering |
| **Budget** | id, scope(consumer/workflow), limit, spent, alerts | Spend limits |

**Stores:** metadata DB (relational) for jobs/personas/usage; object storage for media/snapshots; vault for secrets; internal data stores accessed read-only for RAG grounding.

---

## 7. Key Interaction Flows

### 7.1 Async generation (e.g., video)
```
Consumer ─POST /v1/video (canonical req, callbackUrl)─▶ API GW ─▶ Router ─▶ Job Engine
Job Engine ─enqueue(video topic)─▶ Queue ─▶ Video Worker ─▶ Adapter ─▶ Provider
Worker ─store output─▶ Object Storage ; ─record cost─▶ Metering
Job Engine ─signed webhook (job succeeded + asset uri)─▶ Consumer callbackUrl
(Consumer may also poll GET /v1/jobs/{id})
```

### 7.2 Real-time voice/avatar
```
Client ─WS/WebRTC connect─▶ API GW ─▶ Realtime Session Svc ─open session─▶ Provider RT API
media/audio streamed bidirectionally; persona loaded from Identity Registry; RAG grounding on demand
```

### 7.3 Agentic run with secure login
```
Consumer ─POST /v1/agentic/run (task, target, credentialScope, callbackUrl)─▶ Job Engine
─▶ Browser-Control Runtime (ephemeral sandbox)
   planner loop: navigate/act/extract; Credential Broker injects secrets from Vault (never returned)
   Citation Recorder logs url+snapshot per fact
─▶ Structured report + citations stored ; webhook to consumer
```

### 7.4 n8n workflow
```
n8n node (Studio: capability=image) ─▶ platform REST ─▶ job ─▶ webhook back to n8n Wait/Resume node
```

---

## 8. Security, Privacy & Governance

- **AuthN/Z:** OIDC for users; scoped API keys/OAuth client-credentials for services (consuming products, n8n). Per-capability and per-budget authorisation scopes.
- **Secrets:** all provider keys and agentic login credentials in a vault; short-lived, runtime-injected; **never logged or returned**.
- **Data protection:** TLS in transit; encryption at rest; configurable retention (interview audio/video PII especially — NFR-7).
- **Consent & rights:** voice cloning and avatar likeness require stored consent metadata; every generated asset carries commercial-usage-rights provenance.
- **Agentic governance:** egress allow-lists, per-site ToS policy, full action/audit logging, human-escalation on blockers; isolation between runs.
- **Auditability:** immutable audit trail of jobs, provider used, cost, and browser actions (NFR-6).

---

## 9. Scalability & Reliability

- **Stateless API tier** behind a load balancer; horizontal autoscaling.
- **Per-modality worker pools** scale independently (GPU pools for video; CPU for PPTX; browser pods for agentic).
- **Queue-based load levelling** smooths bursts; back-pressure and concurrency caps per provider (respect provider rate limits).
- **Idempotent jobs + retries with backoff**; dead-letter queues for poison jobs.
- **Realtime tier** scaled separately with session affinity and low-latency media routing.
- **Availability** 99.9% target for API/orchestration (NFR-3); providers treated as external dependencies with circuit breakers and fallbacks.

---

## 10. Cost Control Design

- **Pre-flight `estimateCost`** on each adapter → optional budget check before enqueue.
- **Metering Service** records actual provider units/cost per job, tagged by consumer/workflow.
- **Budgets** with soft (alert) and hard (block) limits per scope.
- **Consumption reports** exposed via API and dashboards; enables tiered-rate/negotiation analysis (U-CC1..3).
- Provider selection policy can prefer **cost-optimised** adapters for non-premium consumers while the premium consumer product defaults to premium.

---

## 11. n8n Integration Design

- Provide a **custom n8n node package** ("internal AI") with one operation set per capability, submitting jobs and supporting the **Wait-for-webhook** pattern for async completion.
- Where a mature official/community node exists for an approved provider, prefer it; otherwise the internal AI node fronts the platform (which itself abstracts providers) — giving n8n workflows a single, stable surface (U-N8N1).

---

## 12. Technology Choices (indicative, to confirm at architecture review)

| Concern | Candidate | Notes |
|--------|-----------|-------|
| API/orchestration | Node/TypeScript or Python (FastAPI) | Team skills; strong async + SDK ecosystems |
| Queue/broker | Managed queue (e.g., SQS/RabbitMQ/Redis Streams) | Per-modality topics |
| Realtime | WebRTC/WebSocket gateway | Voice/avatar streaming |
| Browser-control | Headless browser automation (Playwright-class) in sandboxed pods | Cap 5 runtime |
| PPTX | OOXML/`python-pptx`-class engine | Editable decks |
| Storage | Object store + relational metadata DB | Assets + job metadata |
| Secrets | Enterprise vault | Provider keys + agentic creds |
| Observability | Metrics + tracing + structured logs stack | Per-job/provider |
| Orchestration/runtime | Containers + autoscaling (Kubernetes-class) | Worker/browser pools |

Final selections depend on architecture review decisions (hosting, data residency, approved vendors — see PRD §8 Open Questions).

---

## 13. Traceability (Requirements → Design)

| Requirement | Design element |
|-------------|----------------|
| U-API1..3 (API-first) | API Gateway + canonical capability contracts |
| U-INT2/3 (queue/callbacks) | Job Engine + Queue + Callback Service |
| U-N8N1 | Custom n8n node + provider fronting |
| U-SC1/2 (scale) | Stateless API + per-modality workers + queue |
| U-CC1..3 (cost) | Metering + Budgets + estimateCost |
| Identity persistence | Asset/Identity Registry |
| Vendor consolidation/future-proof | Provider Adapter Layer + Capability Registry |
| Cap 5 secure login + citations | Browser-Control Runtime + Credential Broker + Citation Recorder |
| NFR-5/6 (security/audit) | Vault, no-secrets-in-logs, immutable audit trail |
| NFR-1 (real-time) | Realtime Session Service |
```
