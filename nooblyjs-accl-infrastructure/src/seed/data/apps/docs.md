---
name: docs
vm: docs-01
status: building
source:
  repo: https://github.com/stevie/docs.git
  branch: main
  dockerfile: ./Dockerfile
  context: .
  gitConnection: github-stevie
run:
  port: 8080
  restart: always
  env: []
healthCheck: /healthz
autoDeploy: false
current: null
createdAt: '{{ago:4m}}'
createdBy: { id: stevie, name: Stevie }
---
