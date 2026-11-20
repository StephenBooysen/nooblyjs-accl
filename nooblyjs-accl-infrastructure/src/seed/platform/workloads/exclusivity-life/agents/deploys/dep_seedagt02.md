---
id: dep_seedagt02
tenantId: exclusivity-life
workload: agents
commit: 4b8f0aa
message: "Try the new planner"
trigger: manual
by: { id: stevie, name: Stevie, kind: person }
operation: null
image: 'registry.mock/exclusivity-life/agents:4b8f0aa'
result: failed
reason: 'Exited with code 1 within 10 seconds of starting: ModuleNotFoundError: No module named ''planner'''
createdAt: '{{ago:40m}}'
startedAt: '{{ago:40m}}'
endedAt: '{{ago:40m}}'
---

{{ago:40m}}  Queued by Stevie (manual)
{{ago:40m}}  Cloning exclusivity-life/digital-teammates at 4b8f0aa
{{ago:40m}}  Built registry.mock/exclusivity-life/agents:4b8f0aa
{{ago:40m}}  Started 1 instance of registry.mock/exclusivity-life/agents:4b8f0aa
{{ago:40m}}  Failed: Exited with code 1 within 10 seconds of starting: ModuleNotFoundError: No module named 'planner'
{{ago:40m}}  Kept 9c2e7d1 running
