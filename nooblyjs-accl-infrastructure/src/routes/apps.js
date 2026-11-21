// /apps and /git (architecture.md §13; roadmap phase 6). Who may do what is checked in the services (product.md §7).
import { handler } from '../util/http.js';
import { notFound } from '../util/errors.js';
import { isResourceName, isGeneratedId } from '../util/ids.js';

export function appRoutes({ host, apps }) {
  const r = host.express.Router();
  const name = (req) => {
    if (!isResourceName(req.params.name)) throw notFound(`No app ${req.params.name}.`);
    return req.params.name;
  };
  r.get('/', handler(async (req, res) => res.json(await apps.list())));
  // The Deploy page's choices; "-form" can't be an app's name (names start with a letter).
  r.get('/-form', handler(async (req, res) => res.json(await apps.formOptions())));
  r.post('/', handler(async (req, res) => res.status(202).json(await apps.create(req.body ?? {}, req.person))));
  r.get('/:name', handler(async (req, res) => res.json(await apps.get(name(req)))));
  r.get('/:name/deploys/:id', handler(async (req, res) => {
    if (!isGeneratedId(req.params.id)) throw notFound(`No deploy ${req.params.id}.`);
    res.json(await apps.deploy(name(req), req.params.id));
  }));
  r.get('/:name/logs', handler(async (req, res) => res.json(await apps.logs(name(req), { lines: req.query.lines }))));
  r.post('/:name/deploy', handler(async (req, res) => res.status(202).json(await apps.redeploy(name(req), req.person))));
  r.post('/:name/stop', handler(async (req, res) => res.status(202).json(await apps.stop(name(req), req.person))));
  r.post('/:name/start', handler(async (req, res) => res.status(202).json(await apps.start(name(req), req.person))));
  r.delete('/:name', handler(async (req, res) => res.status(202).json(await apps.remove(name(req), req.body ?? {}, req.person))));
  return r;
}

export function gitRoutes({ host, git }) {
  const r = host.express.Router();
  const id = (req) => {
    if (!isResourceName(req.params.id)) throw notFound(`No Git connection ${req.params.id}.`);
    return req.params.id;
  };
  r.get('/connections', handler(async (req, res) => res.json({ connections: await git.list(), help: git.TOKEN_HELP })));
  r.post('/connections', handler(async (req, res) => res.status(201).json(await git.add(req.body ?? {}, req.person))));
  r.get('/connections/:id', handler(async (req, res) => res.json(await git.get(id(req)))));
  r.post('/connections/:id/test', handler(async (req, res) => res.json(await git.test(id(req), req.person))));
  r.delete('/connections/:id', handler(async (req, res) => res.json(await git.remove(id(req), req.person))));
  r.post('/check', handler(async (req, res) => res.json(await git.check(req.body ?? {}, req.person))));
  return r;
}
