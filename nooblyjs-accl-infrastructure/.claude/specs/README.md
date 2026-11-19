---
type: "Spec index"
title: "Specs: Noobly Cloud platform hosting (roadmap phase 8)"
description: "Why phase 8 exists, the order its specs are built in, and what each one adds to the accelerator."
tags: ["infrastructure", "spec", "phase-8"]
---

# Specs: platform hosting (roadmap phase 8)

**Why.** NooblyJS Cloud (`nooblyjs-apps/nooblyjs-apps-hero-co`) is a Heroku/Render-style hosting product for many
customers. It loads this accelerator with `mount()` and uses it as its control plane: clouds, VMs, the operations
engine, endpoints, buckets and databases. Its steering (`hero-co/.claude/steering/stack.md` §3.2) lists what this
accelerator lacks for that job. Phase 8 adds it **here**, in the accelerator, so any launcher gets it, and keeps the
accelerator's rules: mock first, offline tests on Express 4 and 5, idempotent steps, every write audited, nothing
touched that was not created by this install.

**What stays the same.** Phases 0–7 and the product (`../../.claude/steering/infrastructure-product.md`) are
unchanged: a team's own VMs, apps, databases and buckets. Phase 8 adds a **platform layer** next to that product,
used through an in-process API by a launcher, plus operator screens. NooblyJS Cloud's customers never see this
accelerator's screens.

**Order.** Each spec says what it needs first. Phases 3 (endpoints), 4 (buckets), 5 (databases) and 6 (deploy from
Git) come before phase 8, because phase 8 builds on their steps.

| Spec | Adds | Needs | Roadmap |
| --- | --- | --- | --- |
| [8.1 Platform API and workloads](08.1-platform-api.md) | The `workload` record, the in-process `services.platform` API, tenant labels, events for launchers | 6 | 8.1 |
| [8.2 Container hosting on shared VMs](08.2-container-hosting.md) | Host pools, many containers per VM with CPU/memory limits, placement, tenant networks, run-to-completion jobs | 8.1 | 8.2 |
| [8.3 Builds and the image registry](08.3-builds-and-registry.md) | Build from source (Node 22, Python 3.12, Go 1.23) or Dockerfile on builder VMs; per-account registry | 8.1, 8.2 | 8.3 |
| [8.4 Instances, ingress and rolling deploys](08.4-ingress-and-instances.md) | Several instances on several VMs, ingress VMs, wildcard and custom domains, zero-downtime rollout | 8.2, 8.3, 3 | 8.4 |
| [8.5 Workload telemetry](08.5-workload-telemetry.md) | Per-container CPU/memory/requests/bandwidth and log streaming to the launcher | 8.2 | 8.5 |
| [8.6 Managed Postgres](08.6-managed-postgres.md) | Postgres 16 on Cloud SQL / RDS, PITR, read replica, HA | 5 | 8.6 |
| [8.7 Managed Key Value](08.7-managed-key-value.md) | Redis-compatible store on Memorystore / ElastiCache | 5 | 8.7 |
| [8.8 Static sites and CDN](08.8-static-sites-cdn.md) | Publish a build output to a bucket served through Cloud CDN / CloudFront | 4, 8.3 | 8.8 |

**How each spec is written.** *Requirements* (numbered, testable), *Design* (records, provider contract, operations
and steps, API, events, mock behaviour), *Tasks* (the checklist; the same boxes are in `infrastructure-roadmap.md`
phase 8: tick both in the same change).

**Words.** A **tenant** is the launcher's unit of isolation (a NooblyJS Cloud workspace); the accelerator stores its
id and never interprets it. A **workload** is one runnable thing a tenant asked for (service, worker, job, static
site). An **instance** is one running container of a workload. A **host** is a VM in a host pool that runs instances.
