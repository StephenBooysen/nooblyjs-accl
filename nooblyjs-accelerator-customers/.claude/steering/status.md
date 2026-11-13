# Steering: customers accelerator, current status

The product definition is `.claude/spec/customer-accelerator-prd.md`; the design is `customer-accelerator-architecture.md`;
the build order is `customer-accelerator-roadmap.md`. This file records **where things stand now**, checked against the
code, so the roadmap does not have to be re-read to answer that question.

## Status (v0.3.0)

| Area | Status | Evidence |
| --- | --- | --- |
| Library mount (`mount()`, `shutdown()`) | Done | `index.js`; `test/unit/mount.test.js` |
| Customer module (CRUD, identities, consent, notes, timeline, audit, organizations) | Done | `src/customer/`; `tests/unit/customer/` |
| Marketing module (templates, campaigns, messages, pipeline, tracking, webhooks, transactional) | Done | `src/marketing/`; `tests/scenario/marketing.test.js` |
| Support (contact centre) module | **Not built.** Status page only. | `src/support/index.js`, `src/support/views/` |
| Shared layer (schema, repository, events, audit, RBAC, HTTP) | Done | `src/shared/`; `tests/unit/shared/` |
| Demo host | Done | `test/app/index.js` (`npm start`) |
| Tests | 243 of 243 pass (13 suites) | `npx jest` |
| Coverage gate | Configured in `package.json` (`coverageThreshold`) | Not run in CI: no workflow in this repository |
| CI | **Missing** | Spec: `.claude/spec/improvements.md` R1 |
| File data provider | Works with a documented race; workaround in place | README; spec `improvements.md` R2 |
| Property test for consent and suppression | **Missing** | Spec: `improvements.md` R8 |

## Next

1. CI and the file-provider fix (`.claude/spec/improvements.md` R1, R2).
2. Support module, Phase 3 of the roadmap (`.claude/spec/improvements.md` R4).

## Verification commands

```bash
cd nooblyjs-accelerator-customers
npm test                  # 243 tests
npm start                 # demo host on :3003; then GET /applications/customer/api/v1/health
```
