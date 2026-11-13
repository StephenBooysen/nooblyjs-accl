# Product Requirements Document (PRD)

**Product:** AI Digital Studio — Brief-to-Media Generation (Video · Image · Audio · Podcast · PPTX)
**Derived from:** `00-business-requirements.md` 
**Owner:** [to be assigned]
**Status:** Draft v1.0
**Consuming products:** the consumer research platform and the category-management suite

---

## 1. Overview

The team requires an **AI Digital Studio**: a solution that takes a **creative brief** and produces a finished **media deliverable** — **video, image, audio, podcast, or PowerPoint** — grounded in the team's proprietary research.

The product's job-to-be-done is a single, end-to-end contract:

> **Brief in → media out.** Submit a brief (objective, audience, source research, brand, deliverable type) and receive a production-quality asset, produced through a governed pipeline of creative planning, generation, assembly, review, and delivery.

The Studio is the product. To produce media it orchestrates a set of **generation abilities** (voice, video, image, digital humans, agentic research, presentations). Those abilities may be served by internal or external providers; the Studio abstracts them behind a normalised interface so providers can be swapped or A/B-compared **without changing the brief-to-media contract**. Provider abstraction is a supporting concern in service of the Studio — not the headline.

The Studio's primary consumer is a consumer research platform, which operates on a high-margin commercial model and can justify premium providers to create differentiation. A category-management suite also consumes the same Studio for category-management decision support.

### 1.1 Problem Statement

- Insight delivery is currently limited to static reports, dashboards, and presentations.
- Producing premium multimedia (video briefings, podcasts, interactive experiences) from a brief is manual, slow, inconsistent, and hard to govern.
- There is no repeatable, brief-driven production pipeline that turns research context into client-ready media with consistent brand/voice identity and an auditable review/approval trail.

### 1.2 Product Vision

A brief-driven AI Digital Studio that turns proprietary research context into premium, client-ready media — video, image, audio, podcast, and editable presentations — through a governed production pipeline (plan → generate → assemble → review → deliver), with consistent brand and talent identity, cited external enrichment, and enterprise-grade cost, security, and audit controls.

### 1.3 Goals (mapped to Strategic Objectives)

| # | Goal | Source Objective |
|---|------|------------------|
| G1 | Turn a brief into premium, differentiated media deliverables end-to-end | Differentiated premium products; expand beyond static reports |
| G2 | Provide a governed production pipeline with review/approval and audit | Intelligence efficiency; scalable foundation |
| G3 | Maintain consistent brand/voice/visual identity across deliverables | Customer engagement; premium differentiation |
| G4 | Enrich deliverables with cited, agentically-gathered external evidence | AI-native product evolution; intelligence efficiency |
| G5 | Keep generation providers swappable behind the Studio (supporting) | Scalable foundation; margin expansion |
| G6 | Provide cost governance (limits, reporting, pay-per-use) | Cost control |

### 1.4 Non-Goals (v1)

- Building proprietary foundation models for voice/video/image (the Studio integrates best-of-breed providers).
- Replacing the consuming applications' front-ends (the Studio is a brief-to-media production backend).
- Long-term data warehousing of research corpora (consumed from existing internal data stores).

### 1.5 The Studio Pipeline (product view)

Every deliverable type flows through the same pipeline; stages scale up or down by deliverable:

1. **Brief intake** — capture objective, audience, source research, brand, and deliverable type; validate and normalise into a canonical Brief.
2. **Creative planning** — generate the storyline/script/scene or slide plan; select talent/brand identities; optionally gather cited external evidence.
3. **Generation** — produce the raw media per modality (voice, image, video, avatar takes, slide content).
4. **Assembly** — compose/edit generated parts into the deliverable (cut, mix, deck build).
5. **Review & QA** — quality-gate rubric plus human approval; iterate with versioning under budget caps.
6. **Delivery** — final render, register asset + usage rights, deliver with callback.

The operating model that runs this pipeline (studio roles → agents, personas/identities, hand-offs, gates) is detailed in `04-studio-roles-agents-and-workflows.md`.

---

## 2. Users & Personas

| Persona | Role | Primary Needs |
|---------|------|---------------|
| **Research Producer** | Briefs the Studio; owns the deliverable | Submit a brief and receive a video/podcast/deck with brand consistency |
| **Insights Analyst** | Supplies source research; requests enrichment | Deliverables grounded in research with cited external sources |
| **Consumer Product Engineer** | Integrates the Studio into a consuming product | Stable brief-submission API, job status, callbacks, predictable latency |
| **Automation Builder** | Triggers Studio jobs from workflows | Native/community n8n nodes to submit briefs and receive deliverables |
| **Creative/Brand Owner** | Governs identity & quality | Consistent brand/voice/visual identity; client-ready output quality |
| **Platform/Cost Owner** | Governs spend & providers | Consumption reports, spend limits, provider swap-ability |
| **Security & Governance** | Enterprise compliance | Credential vaulting, audit logs, approval trail, data-residency controls |

---

## 3. Scope & Capability Requirements

### 3.0 Deliverable types (what the Studio produces from a brief)

| Deliverable | Description | Generation abilities used |
|-------------|-------------|---------------------------|
| **Video** | Documentaries, executive briefings, insight storytelling | C2 Video + C1 Voice (+ C3 Image, C4 Avatar) |
| **Image** | Report/presentation imagery, personas, product/brand visuals | C3 Image |
| **Audio** | Narrated summaries, single-voice audio briefings | C1 Voice |
| **Podcast** | Multi-voice, scripted conversational audio | C1 Voice (multi-speaker) + scripting |
| **PowerPoint** | Editable, brand-consistent presentations with charts/infographics | C6 Presentations (+ C3 Image) |

Any deliverable may be **enriched** with cited external evidence via C5 (Agentic Research). Avatar-led (C4) variants apply to video/presenter deliverables.

### 3.1 Generation abilities (building blocks)

To produce the deliverables above, the Studio orchestrates six generation abilities. Each is exposed via a normalised interface and (where feasible) an n8n node. Underlying providers are pluggable behind a provider-abstraction interface (a supporting concern — see §7 and the Architecture doc).

### Capability 1 — AI Voice
**Product requirements:**
- P-V1: Text-to-speech and speech-to-text via unified endpoints.
- P-V2: Real-time, low-latency, streaming voice conversation.
- P-V3: Persistent voice personas (consistent identities reusable across jobs).
- P-V4: Multi-speaker conversations; voice cloning (governed/consented).
- P-V5: Prosody controls — emotion, style, pacing, emphasis, accent.
- **Acceptance:** Commercial-grade, human-like output; persona reused across ≥2 sessions with perceptually consistent identity; streaming first-audio latency target defined in NFRs.

### Capability 2 — AI Video Generation
**Product requirements:**
- P-VG1: Generation methods — text-to-video, image-to-video, storyboard-to-video, scene-to-scene.
- P-VG2: Scene/shot control — first/last-frame, camera, character, asset seeding, storyboard stitching, narrative continuity.
- P-VG3: Asset consistency — character, product, brand, environment across scenes.
- P-VG4: Native audio — narration, dialogue, SFX, ambient, voice integration (interop with Capability 1).
- P-VG5: Quality — high-quality lip-sync, multi-character scenes, realistic motion/physics, selectable render tiers, high-resolution output.
- **Acceptance:** Cinematic-quality output suitable for client delivery with minimal post-production; identity persists across a multi-scene render.

### Capability 3 — AI Image Generation
**Product requirements:**
- P-IG1: High-fidelity, high-resolution generation.
- P-IG2: Fine scene control; accurate text rendering.
- P-IG3: Character/brand/product consistency; seed-image support; style control.
- P-IG4: Commercial usage rights on outputs.
- **Acceptance:** Professional-grade images with accurate embedded text and consistent recurring assets.

### Capability 4 — Digital Humans & Avatars
**Product requirements:**
- P-DH1: Real-time avatar + voice interaction (audio-visual conversation), webcam input support.
- P-DH2: High-quality facial animation and lip-sync.
- P-DH3: Persistent personas across sessions.
- P-DH4: Retrieval-grounded conversation (RAG over supplied research context).
- **Acceptance:** Natural, low-latency, real-time interaction with session-to-session persona consistency.

### Capability 5 — Agentic Research & Intelligence
**Product requirements:**
- P-AR1: Web search + multi-step reasoning + research synthesis.
- P-AR2: Browser interaction/navigation (the platform's namesake "browser-control" subsystem).
- P-AR3: Source retrieval, citation support, citation traceability.
- P-AR4: Structured report generation from agent runs.
- P-AR5: Agent-based task execution with **secure credential login** to gated systems.
- P-AR6: Robustness — navigate varied frameworks; overcome pop-ups, banners, and challenges.
- **Acceptance:** Reliable, reproducible runs; every claim in the structured output is traceable to a retrieved source; credentials never exposed in logs/outputs.

### Capability 6 — AI-Powered Presentation & Data Storytelling
**Product requirements:**
- P-PR1: Generate complete, **editable PowerPoint** decks from supplied context or explicit slide descriptions.
- P-PR2: Automated narrative/storyline and structure generation.
- P-PR3: Visual design — professional/executive layouts, visual hierarchy, brand compliance, integrated imagery (interop with Capability 3).
- P-PR4: Data visualisation — automated chart selection/generation, executive-friendly statistical viz.
- P-PR5: Infographics — process/concept/framework/journey/relationship/org visualisation, information hierarchy.
- **Acceptance:** Outputs resemble professional consulting deliverables, not generic AI decks; PPTX opens and is fully editable in PowerPoint.

---

## 4. Universal (Cross-Capability) Requirements

### 4.1 API Accessibility
- U-API1: All capabilities exposed via comprehensive, documented, production-grade APIs.
- U-API2: API surface provides substantially the same controls as any provider UI (no UI-only advanced features).
- U-API3: Prefer providers whose advanced controls are fully programmatic.

### 4.2 Integration
- U-INT1: Support enterprise integration patterns and programmatic access.
- U-INT2: **Job queuing** for long-running generation tasks.
- U-INT3: **Callbacks/webhooks** on completion.

### 4.3 n8n Compatibility
- U-N8N1: Native n8n nodes preferred; mature/secure community nodes acceptable; officially supported integrations preferred.

### 4.4 Scalability
- U-SC1: Support individual experimentation → team use → product integration → enterprise scale.
- U-SC2: Support multiple concurrent programmatic connections.

### 4.5 Cost Control
- U-CC1: Billing/consumption reporting per capability, product, and workflow.
- U-CC2: Configurable spend limits/budgets with alerts.
- U-CC3: Prefer pay-per-use entry (no minimum commitments); support future tiered/negotiated rates.

---

## 5. Non-Functional Requirements (NFRs)

| ID | Category | Requirement (target) |
|----|----------|----------------------|
| NFR-1 | Latency (real-time) | Voice/avatar streaming first-response ≤ 800 ms; turn-taking feels natural |
| NFR-2 | Throughput | ≥ N concurrent generation jobs (configurable; horizontally scalable workers) |
| NFR-3 | Availability | 99.9% for the orchestration/API tier |
| NFR-4 | Reliability | Agentic runs reproducible; automatic retry with idempotent job keys |
| NFR-5 | Security | Secrets in a vault; encryption in transit/at rest; no secrets in logs |
| NFR-6 | Auditability | Full audit trail of jobs, providers used, cost, and agent browsing actions |
| NFR-7 | Data governance | Configurable data residency & retention; PII handling for interviews |
| NFR-8 | Portability | Provider swap without changing consumer API contracts |
| NFR-9 | Observability | Metrics, tracing, structured logs per job and per provider call |
| NFR-10 | Compliance | Commercial usage rights tracked per generated asset |

*(N and exact targets to be finalised with the consuming products' capacity planning.)*

---

## 6. Success Metrics (KPIs)

- **Adoption:** # of consuming-product features backed by the platform; # of active n8n workflows.
- **Deliverable quality:** % of multimedia outputs delivered to clients with minimal post-production (target ≥ 80%).
- **Agentic reliability:** agentic run success rate; % of output claims with traceable citations (target 100%).
- **Time-to-deliverable:** median time to produce a video/podcast/deck vs. manual baseline (target ≥ 50% reduction).
- **Cost governance:** % of spend within configured budgets; per-deliverable unit cost trend.
- **Vendor agility:** time to add/swap a provider (target < 1 sprint) with zero consumer contract changes.

---

## 7. Provider Evaluation Criteria (supporting concern — for architecture review)

The Studio abstracts its generation providers so they can be swapped without changing the brief-to-media contract. As a **supporting** activity, providers behind each generation ability are evaluated on:

- **Visual fidelity:** realistic lighting/motion/physics; cinematic quality (Capabilities 2, 3).
- **Identity persistence:** consistency of voices/characters/brand/product across sessions and outputs.
- **Fine creative control:** scene/shot/character/style/narrative/audio control vs. prompt-only.
- **Real-time performance:** low latency, streaming, natural turn-taking (Capabilities 1, 4).
- **Commercial output quality:** client-ready with minimal post-production.
- **Vendor consolidation:** minimise vendor sprawl, integration complexity, operational overhead.
- **Future-proofing:** rapid innovation, emerging modalities, strong roadmap, flexible integration, extensibility.

The provider-abstraction design (see Architecture doc) directly enables consolidation and future-proofing by decoupling consumers from specific vendors.

---

## 8. Assumptions, Dependencies & Open Questions

**Assumptions**
- Proprietary research content is available from existing internal data stores for grounding/RAG.
- n8n is (or will be) the organisation's primary automation/orchestration layer.
- Premium provider spend is acceptable for the premium consumer product given its high-margin model.

**Dependencies**
- Secrets management/vault, identity provider, and enterprise logging/monitoring.
- Brand asset library (logos, fonts, colour palettes, templates) for consistency requirements.

**Open Questions**
1. Preferred cloud/hosting and data-residency constraints?
2. Concrete concurrency/throughput targets from the consuming products?
3. Build vs. buy per capability — approved provider shortlist and budget ceilings?
4. Consent/legal framework for voice cloning and avatar likeness?
5. Governance scope for agentic browser automation of third-party sites (ToS/compliance)?

---

## 9. Release Strategy (product view)

Releases are framed by the **deliverable types the Studio can produce end-to-end from a brief**:

- **Phase 1 (Studio foundation):** Brief intake + pipeline spine (planning → generation → review → delivery) with the first deliverables — **Audio** (C1 voice) and **Image** (C3), plus **PowerPoint** (C6) drafts. Provider abstraction, job queue + callbacks, n8n, cost/telemetry built in.
- **Phase 2 (Rich media):** **Video** (C2) documentaries/briefings and full **PowerPoint** storytelling; **Podcast** (multi-voice C1).
- **Phase 3 (Interactive & enriched):** **Agentic research enrichment** (C5, cited sources) and **avatar-led** (C4) video/presenter deliverables; real-time voice.
- **Phase 4 (Scale & govern):** enterprise scale, advanced cost/approval governance, provider A/B and swap, hardening.

Detailed sequencing and indicative timelines in `03-implementation-plan.md`.
