// The platform's hooks (spec 8.4), answered without a sign-in because Caddy on the ingress VMs (and visitors' browsers,
// for wake) call them. A launcher that gates its mount lets exactly HOOKS_PUBLIC through.
//
// GET /hooks/platform/tls-ask?domain=  Caddy's on-demand TLS permission (8.4.5): 200 only for a verified custom domain
//                                      of a live workload or a platform name, else 404. It says nothing else.
// GET /hooks/platform/wake?host=&path=  a sleeping service (8.4.8): starts it, waits until it answers (up to a minute),
//                                      then sends the visitor back to https://<host><path>. Answers only for a host
//                                      some workload has; the path is kept to its own characters.
//
// POST /hooks/git/:app  an app's push webhook (roadmap 6.9): GitHub's X-Hub-Signature-256 or GitLab's X-Gitlab-Token
//                       must match the app's secret (apps.push()); the raw body is kept for the HMAC.
import { handler } from '../util/http.js';

export const HOOKS_PUBLIC = ['/hooks/platform/tls-ask', '/hooks/platform/wake'];
/** The prefix of the apps' webhooks: POSTs a gating launcher lets through without a sign-in. */
export const GIT_HOOKS_PREFIX = '/hooks/git/';
const HOST = /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,1000}$/;

export function hookRoutes({ host, ingress, wake }) {
  const r = host.express.Router();
  r.get('/hooks/platform/tls-ask', handler(async (req, res) => {
    const domain = String(req.query.domain ?? '').toLowerCase();
    res.set('Cache-Control', 'no-store');
    res.status(HOST.test(domain) && await ingress.tlsAsk(domain) ? 200 : 404).type('text/plain').send('');
  }));
  r.get('/hooks/platform/wake', handler(async (req, res) => {
    const name = String(req.query.host ?? '').toLowerCase();
    const path = PATH.test(String(req.query.path ?? '/')) ? String(req.query.path ?? '/') : '/';
    res.set('Cache-Control', 'no-store');
    const found = HOST.test(name) ? await ingress.find(name) : null;
    if (!found) return res.status(404).type('text/plain').send('No service answers on this address.');
    const awake = await wake(found.tenantId, found.w.name, { waitMs: 60_000 });
    if (!awake) {
      res.set('Retry-After', '5');
      return res.status(503).type('text/plain').send('The service is waking up. Try again in a few seconds.');
    }
    return res.redirect(307, `https://${name}${path}`);
  }));
  return r;
}

export function gitHookRoutes({ host, apps }) {
  const r = host.express.Router();
  r.post('/hooks/git/:app', host.express.raw({ type: () => true, limit: '1mb' }), handler(async (req, res) => {
    const { status, body } = await apps.push(req.params.app, { headers: req.headers, raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
    res.status(status).json(body);
  }));
  return r;
}
