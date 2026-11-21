---
id: op_seeddeploy
type: app.deploy
resource: { type: vm, name: docs-01 }
account: stevie-prod
label: Deploy docs to docs-01
status: queued
progress: 0
steps:
  - { key: source, label: Check the source, status: pending }
  - { key: clone, label: Clone the repository, status: pending }
  - { key: build, label: Build the image, status: pending }
  - { key: env, label: Write the environment, status: pending }
  - { key: start, label: Start the container, status: pending }
  - { key: health, label: Check health, status: pending }
  - { key: switch, label: Go live on HTTPS, status: pending }
  - { key: retire, label: Stop the previous version, status: pending }
  - { key: prune, label: Clean up old images, status: pending }
state: {}
input: { app: docs, deploy: dep_seeddocs01, trigger: person }
requestedBy: { id: stevie, name: Stevie }
createdAt: '{{ago:1m}}'
---

{{ago:1m}}  Queued: Deploy docs to docs-01 (by Stevie)
