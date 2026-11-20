---
tenantId: exclusivity-life
name: etl
kind: job
region: af-south-1
account: null
source: { repo: exclusivity-life/software-factory, branch: main, rootDir: jobs/etl, gitConnection: null }
build: { runtime: python312, buildCommand: pip install -r requirements.txt, startCommand: python etl.py, dockerfile: null }
run: { port: null, command: python etl.py --daily, env: [ { key: DATABASE_URL, link: { database: database } } ] }
plan: { cpu: 0.5, memoryMb: 1024 }
instances: 1
healthCheck: null
domains: []
autoDeploy: { branch: main, webhookSecretRef: null }
schedule: "0 2 * * *"
lastRun: { operation: null, result: succeeded, exitCode: 0, at: '{{today:02:00}}' }
status: live
current: { deployId: dep_seedetl01, commit: f02b6d8, image: 'registry.mock/exclusivity-life/etl:f02b6d8' }
observed: { running: 0, stopped: 0, seenAt: '{{ago:3m}}' }
createdAt: '{{ago:10d}}'
createdBy: { id: stevie, name: Stevie, kind: person }
---
