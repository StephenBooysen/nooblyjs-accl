# Decision log: AI Digital Studio

Every decision the Studio needs before or during the build, what it blocks, and the date it is needed by. The start date
for Phase 1 is **1 February 2027** (assumed; confirmed on 13 November 2026). Owners are not named in the source documents,
so they are marked to be assigned.

Status values: **Confirmed** (decided), **Open** (needs an answer), **Proposed default** (the build can proceed on this
default unless someone objects).

## Confirmed

| ID | Decision | Date | Source |
| --- | --- | --- | --- |
| D-01 | Phase 1 start: Monday 1 February 2027. Phase windows re-planned from it. | 13 Nov 2026 | `implementation-plan.md` §2 |
| D-02 | Code layout: built on the monorepo's `nooblyjs-core` and mounted in the launcher, like the infrastructure accelerator. | 13 Nov 2026 (to confirm in writing) | `steering/product.md` gap 3 |

## Needed before Phase 1 starts (1 February 2027)

| ID | Question | What it blocks | Proposed default if undecided | Owner |
| --- | --- | --- | --- | --- |
| D-03 | **Hosting and data residency** (PRD §8 Q1). Which cloud, which regions, which data may leave the organisation? | Infrastructure, storage choice (R10), any provider call | Single region, one cloud; no data leaves the region | [to be assigned] |
| D-04 | **Throughput and concurrency targets** (PRD §8 Q2; NFR-2). How many concurrent jobs per consumer? | Queue sizing (R5), worker scaling, budget design | 10 concurrent jobs per consumer; scale workers by queue depth | [to be assigned] |
| D-05 | **Build versus buy and the provider shortlist**, with budget ceilings (PRD §8 Q3). | Provider adapters (R6) and the cost model (R8) | Start with one image adapter and one voice adapter, chosen for cost and output quality | [to be assigned] |
| D-06 | **Technology choices** (architecture §12): API framework, queue, storage, PPTX engine. To be confirmed at architecture review. | Phase 1 scaffolding (R1), the job engine (R4), storage (R10) | API: the platform's own Node.js stack; queue: a managed queue with per-type topics; storage: object store plus relational DB; PPTX: an OOXML library | [to be assigned] |
| D-07 | **Agent orchestration mechanism** (roles §9 Q1): n8n workflows, an internal planner service, or a hybrid. | Pipeline spine (R0) and the role model | Hybrid: the job engine runs the fixed six-stage pipeline; n8n submits and receives jobs only | [to be assigned] |
| D-08 | **Creative-agent autonomy** (roles §9 Q2): how far may creative agents act before a person approves? | Review gate design (spec §3) | A person approves at every review gate in Phase 1; no autonomous approval | [to be assigned] |
| D-09 | **Persona approval and consent record** (roles §9 Q3; PRD §8 Q4 for voice cloning). Who may create a voice or avatar persona, and what consent is recorded? | Asset and identity registry (R9) | Personas are created by a named person and carry a consent flag; voice cloning is out of Phase 1 | [to be assigned] |
| D-10 | **Artefact schemas as versioned objects** (roles §9 Q4): are Brief, Script, Storyboard, Cut and Review package formal, versioned platform objects? | Pipeline spine (R0) and the API | Yes: each artefact is a versioned record with a schema | [to be assigned] |
| D-11 | **Review-loop and budget caps per consumer** (roles §9 Q5). | Metering and budgets (R8) | Soft limit at 80% of budget (warning), hard limit at 100% (refuse new jobs) | [to be assigned] |
| D-12 | **Accountable owner** for the Studio. Currently "to be assigned" in every document. | Every decision above | None; must be a named person | [to be assigned] |

## Needed before a later phase

| ID | Question | Needed before | Proposed default | Owner |
| --- | --- | --- | --- | --- |
| D-13 | **Governance of browser automation** on third-party sites (PRD §8 Q5): terms of service, consent, which sites are allowed. | Agentic research (Phase 3), starting 5 July 2027 | Allow-list of sites only; no logins to third-party systems without a recorded approval | [to be assigned] |
| D-14 | **Voice-cloning and avatar-likeness consent framework** (PRD §8 Q4). | Real-time voice and avatars (Phase 3), and any voice cloning | Cloning and likeness are off until a written consent process exists | [to be assigned] |
| D-15 | **Video render tiers and cost per tier** (for Phase 2 video). | Video worker design, starting 12 April 2027 | Three tiers (draft, standard, final); the consumer picks the tier per job | [to be assigned] |

## Housekeeping (not decisions, but needed)

- The four Studio documents cite `01-…` to `04-…` file names that differ from the files in the folder. Update the references
  to the actual names (`product-requirements.md`, `architecture-design.md`, `implementation-plan.md`,
  `studio-roles-agents-and-workflows.md`) and the business requirements file (`00-business-requirements.md`).
- Names of internal teams, consumers and people were removed from all Studio documents on 13 November 2026 (checked by search).
  Keep them out of new text: refer to "the consuming products", "the category-management suite" and "the team".
