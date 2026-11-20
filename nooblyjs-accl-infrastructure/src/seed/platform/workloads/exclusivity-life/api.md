---
tenantId: exclusivity-life
name: api
kind: service
region: af-south-1
account: null
source: { repo: exclusivity-life/engx-platform, branch: main, rootDir: "", gitConnection: null }
build: { runtime: node22, buildCommand: npm ci, startCommand: node server.js, dockerfile: null }
run: { port: 10000, command: null, env: [ { key: NODE_ENV, value: production }, { key: DATABASE_URL, link: { database: database } }, { key: REDIS_URL, link: { keyvalue: cache } } ] }
plan: { cpu: 1, memoryMb: 2048 }
instances: 2
healthCheck: { path: /health, timeoutS: 60 }
domains: [ api-exclusivity.nooblyjs.app ]
autoDeploy: { branch: main, webhookSecretRef: null }
status: live
current: { deployId: dep_seedapi02, commit: a1f3c9e, image: 'registry.mock/exclusivity-life/api:a1f3c9e' }
observed: { running: 2, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:21d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
