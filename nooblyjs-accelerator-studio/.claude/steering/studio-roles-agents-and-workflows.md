# AI Digital Studio — Roles, Processes & Agent/Persona Mapping

**Product:** AI Digital Studio — Brief-to-Media Generation (Video · Image · Audio · Podcast · PPTX)
**Derived from:** `00-business-requirements.md`, `01-product-requirements.md`, `02-architecture-design.md`, `03-implementation-plan.md`
**Owner:** [to be assigned]
**Status:** Draft v1.0
**Purpose of this doc:** Explain how a real digital studio is organised (its roles and processes) and translate those concepts into **agents, personas, and orchestrated workflows** that the AI Digital Studio implements to turn a **brief** into finished media deliverables (video briefings, insight documentaries, research podcasts, executive presentations, images, and audio).

---

## 1. Why model a studio at all?

A professional studio is not just a collection of tools — it is a **division of labour with defined hand-offs, review gates, and a chain of command**. The value is in the *process*: each role owns a specific decision, produces a specific artefact, and hands it to the next role through a defined gate. Undefined hand-offs create bottlenecks, rework, and inconsistency.

The platform already has the mechanical substrate for this (Job Engine, per-modality workers, Provider Adapter Layer, Asset/Identity Registry, Callback/Webhook Service — see `02-architecture-design.md`). What this document adds is an **orchestration pattern on top of that substrate**: a crew of specialised agents, each mapped to a studio role, coordinated through a workflow that mirrors the real production pipeline. This directly supports the BRD's premium multimedia use cases and the "outputs that resemble professional deliverables, not generic AI output" differentiator.

**Design principle:** *Roles become agents. Deliverables between roles become artefacts. Hand-offs become jobs and callbacks. Review gates become approval steps. Recurring identities (a narrator's voice, a brand look) become persisted personas/identities.*

---

## 2. How a real digital video studio is organised

Studios organise people into **three tiers across a five-stage pipeline**. The tiers describe *authority and involvement*; the stages describe *sequence*.

### 2.1 The three crew tiers

| Tier | Who | Involvement |
|------|-----|-------------|
| **Above the line** | Key creatives & decision-makers: Executive Producer, Producer, Director, Screenwriter, Casting Director | Own the vision, budget, and creative direction; involved from development to delivery. |
| **Below the line** | Execution crew during production: 1st AD, DP/Cinematographer, Gaffer, Sound Mixer, Production Designer, Art Director, etc. | Realise the vision on set; mostly active during the production phase. |
| **Post-production** | Assembly & finishing: Post Supervisor, Editor, VFX Artist, Colorist, Sound Designer, Composer, Music Supervisor | Assemble raw footage into the finished deliverable. |

### 2.2 The five pipeline stages

1. **Development / Strategy** — the brief, concept, objectives, audience, budget. Ends in an approved concept.
2. **Pre-production** — script, storyboard, shot list, casting, asset/reference prep, scheduling. Ends in an approved plan (the single biggest lever on cost and quality).
3. **Production** — capturing footage/audio (in an AI studio: *generating* footage from prompts, references, and seeds).
4. **Post-production** — editing/assembly, VFX, colour, sound design, music, mix.
5. **Review & Delivery** — structured feedback, versioning, formal sign-off, export, and archiving.

**Critical insight (from AI-native studios):** AI dramatically accelerates stages 1–4, but **stage 5 (review & approval) remains the bottleneck** because it is a human/governance process. More output volume means *more* to review. A well-designed agent studio therefore treats **review, versioning, and approval as first-class workflow steps**, not an afterthought — this maps to the platform's audit trail, job/version tracking, and human-escalation requirements (NFR-6).

---

## 3. Traditional roles → platform agents (the crew)

Below, each key studio role is mapped to an **agent** on the platform. Agents are orchestrated processes (candidate implementation: an n8n workflow node and/or a coordinating LLM-driven planner) that call the platform's capability APIs. Agents that carry a consistent, reusable identity (voice, avatar, visual style) are backed by **personas/identities** in the Asset/Identity Registry.

Legend for capability references: **C1** Voice · **C2** Video · **C3** Image · **C4** Avatars · **C5** Agentic browser-control · **C6** Presentations.

### 3.1 Above-the-line agents (vision, coordination, governance)

| Studio role | Platform agent | Responsibility in the platform | Primary capabilities / services |
|-------------|----------------|-------------------------------|---------------------------------|
| **Executive Producer / Producer** | **Producer Agent** (orchestrator) | Owns the whole job: interprets the brief, plans the pipeline, dispatches work to other agents, enforces budget, tracks status, drives review gates and final delivery. This is the top-level coordinator. | Job Engine, Cost & Usage Metering, Budgets, Callback/Webhook Svc |
| **Director** | **Director Agent** | Owns creative vision and consistency: sets tone/style, approves the storyboard, makes "which take" judgement calls, ensures continuity across scenes. Arbiter of quality against the creative brief. | Capability Router, Asset/Identity Registry (style), all workers (review authority) |
| **Screenwriter** | **Scriptwriter Agent** | Turns research context/brief into a narrative script, VO copy, and slide/scene descriptions. | LLM planner; RAG over internal data stores |
| **Casting Director** | **Casting / Persona Agent** | Selects and provisions the personas: which narrator voice (C1), which on-screen avatar (C4), which visual identities (character/brand/product). Registers consent metadata. | Asset/Identity Registry, `POST /v1/personas`, `POST /v1/identities` |
| **1st Assistant Director** | **Scheduler / Coordinator Agent** | Builds the execution plan/DAG, sequences jobs, manages dependencies and concurrency, chases stalled jobs, keeps the "shoot" on schedule and budget. | Job Engine, Queue, Scheduler logic |

### 3.2 Below-the-line agents (pre-production & "production"/generation)

| Studio role | Platform agent | Responsibility in the platform | Primary capabilities |
|-------------|----------------|-------------------------------|----------------------|
| **Storyboard Artist** | **Storyboard Agent** | Converts script into shot-by-shot visual panels *before* any expensive generation — the key revision-reducing step. | C3 (Image), storyboard structure |
| **Director of Photography (DP)** | **Cinematography Agent** | Defines shot-level visual controls: framing, camera moves, first/last-frame, lighting mood; passes canonical `controls` to the video adapter. | C2 (Video) scene/shot controls |
| **Production Designer / Art Dept** | **Art / Visual Identity Agent** | Establishes and enforces the look: environments, brand palette, product/character consistency; seeds visual identities used across scenes. | C3, Asset/Identity Registry (VisualIdentity) |
| **Camera Operator / VFX plate gen** | **Video Generation Worker** (via agent) | Executes the actual footage generation (text/image/storyboard-to-video, scene-to-scene) per shot. | C2 Video Worker + adapters |
| **Sound Mixer / VO talent** | **Voice Agent** | Generates narration/dialogue with the cast persona; prosody (emotion, pacing, emphasis, accent); multi-speaker. | C1 Voice |
| **Digital-human presenter** | **Avatar / Presenter Agent** | Real-time or rendered on-screen presenter; lip-sync; retrieval-grounded delivery. | C4 Avatars (+ C1 voice) |
| **Researcher / Fact-checker** | **Research Agent** | Gathers external supporting evidence, competitor/market context, and **cited sources** to ground the narrative; can log into gated sources securely. | C5 Agentic browser-control |

### 3.3 Post-production agents (assembly & finishing)

| Studio role | Platform agent | Responsibility in the platform | Primary capabilities |
|-------------|----------------|-------------------------------|----------------------|
| **Post-Production Supervisor** | **Post Supervisor Agent** | Coordinates the assembly pipeline; ensures every finishing step completes and is signed off before delivery. | Job Engine, Callback Svc |
| **Editor** | **Editor / Assembly Agent** | Assembles generated shots + audio into a cohesive timeline (storyboard stitching, narrative continuity); produces the rough then final cut. | C2 (assembly), audio compositing |
| **Colorist** | **Grade / Style-Finishing Agent** | Applies consistent colour/visual finishing for a cohesive, cinematic look. | C2/C3 style finishing |
| **Sound Designer / Composer / Music Supervisor** | **Audio Post Agent** | Adds SFX, ambient, music bed, final mix; secures/verifies usage rights for any music. | C1 + audio compositing; usage-rights metadata |
| **Presentation Builder** | **Deck / Storytelling Agent** | For presentation deliverables: builds the editable PPTX narrative, layouts, charts, and infographics. | C6 Presentations (+ C3 imagery) |
| **Post-production QC** | **QC / Reviewer Agent** | Runs the quality-gate rubric ("client-ready with minimal post-production"), flags issues, prepares the review package. | Quality gate; human-review rubric |
| **Client / Stakeholder review** | **Approval Gate** (human-in-the-loop) | Collects structured feedback, tracks versions, records formal sign-off. **Human decision point.** | Callback Svc, audit trail, version tracking |

---

## 4. Personas vs. agents (important distinction)

These two concepts are often conflated. The platform should keep them separate:

- **Agent** = a *worker/role in the process* (Director Agent, Editor Agent). It has responsibilities, inputs, outputs, and hand-offs. It is ephemeral per job. It is *how work gets done*.
- **Persona / Identity** = a *persistent, reusable identity* stored in the Asset/Identity Registry (e.g., "Aria — the narrator voice", "Sam — the presenter avatar", "the App A brand visual identity"). It carries consent and usage-rights metadata and is *reused across many jobs* for consistency (BRD "identity persistence" differentiator).

> The **Casting/Persona Agent** is what selects and binds a **persona** to a job. The **Voice Agent** and **Avatar Agent** then *perform as* that persona. This separation is what lets the studio maintain a consistent narrator or presenter across dozens of deliverables while swapping the underlying provider freely (NFR-8).

### 4.1 Suggested seed persona catalogue (illustrative)

| Persona | Type | Backed by | Used by agents |
|---------|------|-----------|----------------|
| "Aria" — Lead Narrator | Voice (C1) | Identity Registry: voiceRef + consent | Voice Agent |
| "Sam" — Executive Presenter | Avatar (C4) + Voice | Identity Registry: avatarRef + voiceRef | Avatar Agent |
| "Brand A" | Visual identity (C3) | Identity Registry: palette, logo, fonts, style refs | Art Agent, Deck Agent |
| "Brand B look" | Visual identity | Identity Registry: template + palette | Art Agent, Deck Agent |

---

## 5. The studio workflow as an orchestrated pipeline

The five studio stages map to an agent workflow (a DAG). Hand-offs are jobs + callbacks; gates are approval steps.

```
STAGE 1: DEVELOPMENT / STRATEGY
  Producer Agent ── interprets brief, sets budget & policy ──▶ creates Project
        │  (RAG pulls proprietary research context)
        ▼
  Scriptwriter Agent ── drafts script / VO / scene descriptions
        │
        ▼
  [GATE A] Director Agent approves concept & script  ◀── (optional human sign-off)
        │
        ▼
STAGE 2: PRE-PRODUCTION
  Casting/Persona Agent ── binds voice/avatar/visual personas (consent checked)
  Storyboard Agent ─────── generates shot panels (C3)   ┐
  Cinematography Agent ─── defines shot controls (C2)    │ prepared in parallel
  Research Agent ───────── gathers cited evidence (C5)   ┘
        │
        ▼
  [GATE B] Director/Client approves storyboard + sources  ◀── (key revision-reducing gate)
        │
        ▼
STAGE 3: PRODUCTION (GENERATION)   ── Scheduler/Coordinator Agent fans out jobs ──
  Video Generation Worker ─ per-shot footage (C2)  ┐
  Voice Agent ───────────── narration/dialogue (C1) │ parallel, per-shot,
  Avatar Agent ──────────── presenter takes (C4)    │ identity-consistent
  Art Agent ─────────────── supporting imagery (C3) ┘
        │
        ▼
STAGE 4: POST-PRODUCTION   ── Post Supervisor Agent coordinates ──
  Editor/Assembly Agent ── stitches shots + audio into a cut
  Grade Agent ──────────── colour/style finishing
  Audio Post Agent ─────── SFX/music/mix (+ usage rights)
  Deck Agent ───────────── (if presentation) builds editable PPTX (C6)
        │
        ▼
  QC/Reviewer Agent ── runs quality-gate rubric, assembles review package
        │
        ▼
STAGE 5: REVIEW & DELIVERY
  [GATE C] Approval Gate (human) ── structured feedback, version compare, sign-off
        │            └── on "changes requested": loop back to relevant stage
        ▼
  Producer Agent ── final render, register asset + usage rights, deliver + webhook
```

### 5.1 Review loops (the bottleneck, handled explicitly)

Because AI generates many variants cheaply, the workflow must handle **iteration** without chaos:

- Every gate can **loop back** to the responsible agent with structured feedback (e.g., Gate C → Editor Agent for a re-cut, or → Cinematography Agent for a re-shoot of one shot).
- Each iteration is a **new version** tracked against the Job/AgentRun, with who-approved-what-when recorded in the audit trail (NFR-6).
- Loops have a **max-iteration / budget cap** enforced by the Producer Agent so cost stays governed (U-CC2).

---

## 6. Chain of command & decision authority

Mirroring the studio hierarchy keeps decisions clear and auditable:

```
                 Producer Agent  (owns job, budget, delivery, final authority on scope)
                        │
        ┌───────────────┼───────────────────────┐
        ▼               ▼                        ▼
  Director Agent   Scheduler/Coord. Agent   Casting/Persona Agent
 (creative veto)   (sequence & pace)        (identity binding + consent)
        │
   ┌────┴───────────────┬───────────────┬───────────────┐
   ▼                    ▼               ▼               ▼
 Storyboard   Cinematography/Video   Voice/Avatar    Research (C5)
        │
        ▼   (hand-off to post)
  Post Supervisor Agent ─▶ Editor ─▶ Grade ─▶ Audio Post ─▶ QC ─▶ Approval Gate (human)
```

- **Producer Agent** = business owner (scope, budget, delivery). Can halt on budget breach.
- **Director Agent** = creative authority (tone, consistency, take selection). Can reject sub-standard output back down the chain.
- **Human Approval Gate** = final external sign-off. No deliverable is "delivered" without a recorded approval.

---

## 7. Mapping summary (studio → platform)

| Studio concept | Platform equivalent |
|----------------|--------------------|
| Crew role | **Agent** (orchestrated worker) |
| Recurring on-screen/voice talent, brand look | **Persona / Visual Identity** (Asset/Identity Registry) |
| Brief / script / storyboard / cut | **Artefacts** passed between agents |
| Hand-off between departments | **Job submission + callback** |
| Production schedule / call sheet | **Scheduler Agent DAG** (job dependencies) |
| Dailies / review screening | **Review package + version tracking** |
| Client approval / sign-off | **Human Approval Gate** (audit-logged) |
| Producer's budget control | **Cost & Usage Metering + Budgets** |
| Consistency across scenes | **Identity persistence** via Registry |
| External research & fact-checking | **Research Agent** (C5 browser-control + citations) |

---

## 8. How this maps to existing architecture (traceability)

| Studio-agent concept | Existing architecture element (`02`) |
|----------------------|--------------------------------------|
| Producer / Scheduler agents | Job Engine, Queue, Capability Router |
| Casting/Persona agent, personas | Asset/Identity Registry; `/v1/personas`, `/v1/identities` |
| Voice / Video / Image / Avatar / Deck agents | Modality Workers + Provider Adapter Layer |
| Research agent | Agentic / Browser-Control Runtime + Citation Recorder |
| Approval Gate, review loops | Callback/Webhook Svc + audit trail (NFR-6) |
| Budget caps on iteration | Cost & Usage Metering + Budgets (U-CC1..3) |
| Consistent narrator/brand across jobs | Identity persistence (BRD differentiator, NFR) |
| Orchestrated crew as a workflow | n8n node package + Job Engine (U-N8N1) |

---

## 9. Implementation notes & suggested next steps

This is a **conceptual/orchestration layer** that sits on top of the capabilities already planned in `03-implementation-plan.md`. It does not require new providers — it requires an **agent-orchestration framework** and a **persona catalogue**.

Suggested phasing (aligns with the existing plan):

1. **Foundation for agents (after Phase 1 spine):** define the canonical *artefact* schemas (Brief, Script, Storyboard, ShotList, Cut, ReviewPackage) and the Producer + Scheduler agents as an n8n/orchestration workflow over the Job Engine.
2. **Voice/Image crew first (Phase 1 capabilities):** Scriptwriter → Casting → Voice → Deck agents can produce audio summaries and presentation decks end-to-end with a human Approval Gate.
3. **Full video crew (Phase 2):** add Storyboard, Cinematography, Video, Editor, Grade, Audio Post agents for documentaries/briefings.
4. **Research & interactive crew (Phase 3):** add Research Agent (C5) for cited grounding and Avatar Agent (C4) for presenter-led deliverables.
5. **Governed studio (Phase 4):** enforce iteration/budget caps, provider swap per agent, and full approval audit.

**Open questions to resolve with the architecture review / delivery team:**

1. Agent-orchestration mechanism: n8n workflows, an internal planner service, or a hybrid?
2. How much autonomy do creative agents (Director, Editor) get before a human gate is mandatory?
3. Persona governance: who approves creation of a new voice/avatar persona and its consent record?
4. Standard artefact schemas — do we formalise Brief/Script/Storyboard/Cut as versioned platform objects?
5. Default review-loop and budget caps per consumer (premium versus cost-optimised).

---

*This document is a conceptual companion to the PRD and Architecture & Design docs; it defines the "studio crew" operating model that turns the platform's raw capabilities into a repeatable, governed production process. Final agent boundaries and orchestration technology are architecture review decisions.*

// ENDS
