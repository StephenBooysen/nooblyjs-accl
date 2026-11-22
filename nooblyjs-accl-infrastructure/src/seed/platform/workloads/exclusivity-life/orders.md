---
tenantId: exclusivity-life
name: orders
kind: job
region: af-south-1
account: null
source: { repo: exclusivity-life/software-factory, branch: main, rootDir: workflows/orders, gitConnection: null }
build: { runtime: node22, buildCommand: npm ci, startCommand: null, dockerfile: null }
run: { port: null, command: null, env: [ { key: DATABASE_URL, link: { database: database } } ] }
plan: { cpu: 1, memoryMb: 2048 }
instances: 1
healthCheck: null
domains: []
schedule: null
concurrency: 4
autoDeploy: { branch: main, webhookSecretRef: null }
status: deploying
current: { deployId: dep_seedord01, commit: 58aa0c3, image: 'registry.mock/exclusivity-life/orders:58aa0c3' }
observed: { running: 0, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:9d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
