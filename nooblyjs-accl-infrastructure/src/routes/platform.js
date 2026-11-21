// The platform layer for operators (spec 8.1, HTTP): /api/v1/platform/*, read-only in 8.1, for the Platform screen and
// support tooling. Operators only (`change-guardrails`); a launcher's tenants never call it: they reach their own
// workloads through the launcher, which calls services.platform in process. Mounted only when the platform is on.
import { handler } from '../util/http.js';
import { localRoutes } from './local.js';
import { POOL_PURPOSES } from '../platform/pools.js';

export function platformRoutes({ host, platform, local = null, pools = null, ingress = null, mountPath = '/infrastructure' }) {
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
  // Sites and servers (spec 8.9), when the launcher passes WebSocket upgrades through.
  if (local) r.use('/local', localRoutes({ host, platform, local, mountPath }));
  // Host pools (spec 8.2.1): operators create a pool, add a host, drain one, and delete an empty pool.
  if (pools) {
    r.get('/pools', handler(async (req, res) => res.json({ pools: await pools.list(), purposes: POOL_PURPOSES })));
    r.post('/pools', handler(async (req, res) => res.status(201).json(await pools.create(req.body ?? {}, req.person))));
    r.get('/pools/:name', handler(async (req, res) => res.json(await pools.get(req.params.name))));
    r.post('/pools/:name/hosts', handler(async (req, res) => res.status(202).json(await pools.grow(req.params.name, req.person))));
    r.post('/hosts/:vm/drain', handler(async (req, res) => res.status(202).json(await pools.drain(req.params.vm, req.person))));
    r.delete('/pools/:name', handler(async (req, res) => res.json(await pools.remove(req.params.name, req.person))));
  }
  // Ingress (spec 8.4.1): per region, its addresses, the last sync and the custom domains waiting for DNS.
  if (ingress) {
    r.get('/ingress', handler(async (req, res) => res.json({ regions: await ingress.view() })));
  }
  return r;
}
