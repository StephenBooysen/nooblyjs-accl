---
tenantId: exclusivity-life
name: storefront
kind: static
region: af-south-1
account: null
source: { repo: stevie/nooblyjs-blog, branch: main, rootDir: "", gitConnection: null }
build: { runtime: node22, buildCommand: npm run build, startCommand: null, dockerfile: null }
run: { port: null, command: null, env: [] }
plan: { cpu: 0.5, memoryMb: 512 }
instances: 1
healthCheck: null
domains: [ storefront-exclusivity.nooblyjs.app ]
autoDeploy: { branch: main, webhookSecretRef: null }
status: live
current: { deployId: dep_seedsto01, commit: 3be19f4, image: 'registry.mock/exclusivity-life/storefront:3be19f4' }
observed: { running: 1, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:18d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
