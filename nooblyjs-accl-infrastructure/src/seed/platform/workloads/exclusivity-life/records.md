---
tenantId: exclusivity-life
name: records
kind: private
region: af-south-1
account: null
source: { repo: exclusivity-life/engx-platform, branch: main, rootDir: services/records, gitConnection: null }
build: { runtime: go123, buildCommand: go build -o records ., startCommand: ./records, dockerfile: null }
run: { port: 10000, command: null, env: [ { key: DATABASE_URL, link: { database: database } } ] }
plan: { cpu: 0.5, memoryMb: 512 }
instances: 1
healthCheck: { path: /healthz, timeoutS: 30 }
domains: []
autoDeploy: { branch: main, webhookSecretRef: null }
status: live
current: { deployId: dep_seedrec01, commit: c47a1e9, image: 'registry.mock/exclusivity-life/records:c47a1e9' }
observed: { running: 1, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:12d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
