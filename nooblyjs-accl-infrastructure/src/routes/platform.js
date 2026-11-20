// The platform layer for operators (spec 8.1, HTTP): /api/v1/platform/*, read-only in 8.1, for the Platform screen and
// support tooling. Operators only (`change-guardrails`); a launcher's tenants never call it: they reach their own
// workloads through the launcher, which calls services.platform in process. Mounted only when the platform is on.
import { handler } from '../util/http.js';

export function platformRoutes({ host, platform }) {
  const r = host.express.Router();
  const p = platform.services;
  r.use(host.requireRole('change-guardrails'));
  r.get('/', handler(async (req, res) => res.json({ ...(await platform.overview()), capacity: await p.capacity() })));
  r.get('/capacity', handler(async (req, res) => res.json(await p.capacity())));
  r.get('/tenants/:tenant/workloads', handler(async (req, res) => {
    const { kind, status } = req.query;
    res.json({ workloads: await p.workloads.list(req.params.tenant, { kind, status }) });
  }));
  r.get('/tenants/:tenant/workloads/:name', handler(async (req, res) => res.json(await p.workloads.get(req.params.tenant, req.params.name))));
  r.get('/tenants/:tenant/workloads/:name/deploys', handler(async (req, res) => {
    res.json(await p.deploys.list(req.params.tenant, req.params.name, { limit: req.query.limit, cursor: req.query.cursor }));
  }));
  r.get('/tenants/:tenant/workloads/:name/deploys/:id', handler(async (req, res) => res.json(await p.deploys.get(req.params.tenant, req.params.name, req.params.id))));
  r.get('/tenants/:tenant/usage', handler(async (req, res) => res.json(await p.usage(req.params.tenant, { from: req.query.from, to: req.query.to }))));
  return r;
}
