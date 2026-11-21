// /endpoints (roadmap phase 3; architecture.md §13): every public HTTPS endpoint, and changing or removing one. Adding
// one is POST /vms/:name/endpoints. Who may is checked in the service (product.md §7: `draft`).
import { handler } from '../util/http.js';
import { badRequest } from '../util/errors.js';
import { isResourceName } from '../util/ids.js';

export function endpointRoutes({ host, endpoints }) {
  const r = host.express.Router();
  r.get('/', handler(async (req, res) => {
    const { vm } = req.query;
    if (vm !== undefined && !isResourceName(String(vm))) throw badRequest('vm is a VM\'s name.');
    res.json({ endpoints: await endpoints.list({ vm: vm === undefined ? undefined : String(vm) }) });
  }));
  r.get('/:id', handler(async (req, res) => res.json(await endpoints.get(req.params.id))));
  r.patch('/:id', handler(async (req, res) => res.status(202).json(await endpoints.change(req.params.id, req.body ?? {}, req.person))));
  r.delete('/:id', handler(async (req, res) => {
    const result = await endpoints.remove(req.params.id, req.person);
    res.status(result.operation ? 202 : 200).json(result);
  }));
  return r;
}
