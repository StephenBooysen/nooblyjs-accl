---
tenantId: exclusivity-life
name: agents
kind: worker
region: af-south-1
account: null
source: { repo: exclusivity-life/digital-teammates, branch: main, rootDir: "", gitConnection: null }
build: { runtime: python312, buildCommand: pip install -r requirements.txt, startCommand: python -m teammates, dockerfile: null }
run: { port: null, command: null, env: [ { key: QUEUE_URL, link: { keyvalue: cache } } ] }
plan: { cpu: 2, memoryMb: 4096 }
instances: 1
healthCheck: null
domains: []
autoDeploy: null
status: live
current: { deployId: dep_seedagt01, commit: 9c2e7d1, image: 'registry.mock/exclusivity-life/agents:9c2e7d1' }
observed: { running: 1, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:14d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
