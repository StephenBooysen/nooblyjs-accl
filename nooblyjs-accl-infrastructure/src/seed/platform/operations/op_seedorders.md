---
id: op_seedorders
type: workload.deploy
resource: { type: workload, tenant: exclusivity-life, name: orders }
account: null
tenant: exclusivity-life
label: Deploy orders (exclusivity-life) e5d21b0
status: running
progress: 0
steps:
  - { key: build, label: Build the image, status: running }
  - { key: rollout, label: Start the new instances, status: pending }
  - { key: health, label: Check health, status: pending }
state: { deployStarted: true }
input: { deployId: dep_seedord02, commit: e5d21b0, trigger: push }
requestedBy: { id: stevie, name: Stevie }
createdAt: '{{ago:2m}}'
startedAt: '{{ago:2m}}'
---

{{ago:2m}}  Queued: Deploy orders (exclusivity-life) e5d21b0 (by Stevie)
{{ago:2m}}  Started
{{ago:2m}}  Step 1 of 3: Build the image
