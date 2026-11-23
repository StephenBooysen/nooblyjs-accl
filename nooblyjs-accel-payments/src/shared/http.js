// HTTP helpers shared by the routers: async wrapping (Express 4 does not catch rejections), the error shape, ETags,
// list parameters, and the Idempotency-Key gate on money-moving routes.
import { PayError } from './errors.js';
import { assertCan } from './runtime.js';

/** Wraps an async handler so its rejection reaches the error handler on Express 4 and 5. */
export const wrap = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

/** { error: { code, message, details[] } }; a fault's message never leaves the server. */
export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'The body is not valid JSON.', details: [] } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'The body is too large.', details: [] } });
    if (err instanceof PayError || (err?.expose && err.status >= 400 && err.status < 500)) {
      return res.status(err.status).json({ error: { code: err.code ?? 'invalid', message: err.message, details: err.details ?? [] } });
    }
    log?.error?.(`[accel-payments] ${req.method} ${req.originalUrl}: ${err?.stack ?? err}`);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.', details: [] } });
  };
}

export function sendDoc(res, doc, status = 200) {
  if (doc?.version) res.set('ETag', `W/"${doc.version}"`);
  return res.status(status).json(doc);
}

/** The version an If-Match header names, or undefined. */
export function ifMatch(req) {
  const m = /^W\/"(\d+)"$/.exec(req.get('if-match') ?? '');
  return m ? Number(m[1]) : undefined;
}

/** filter[field]=value pairs from the query. */
export function filtersOf(query) {
  const out = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    const m = /^filter\[([A-Za-z0-9_.]+)\]$/.exec(k);
    if (m && typeof v === 'string') out[m[1]] = v;
  }
  if (query?.filter && typeof query.filter === 'object') {
    for (const [k, v] of Object.entries(query.filter)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export const matches = (doc, filters) => Object.entries(filters).every(([k, v]) => String(k.split('.').reduce((o, p) => o?.[p], doc) ?? '') === v);

const REPLY = Symbol('reply');
/** A handler's answer with a status other than 200 (a plain return value is sent as 200). */
export const reply = (status, body = null) => ({ [REPLY]: true, status, body });
const unpack = (out) => (out?.[REPLY] ? { status: out.status, body: out.body } : { status: 200, body: out });

/** Checks the permission, then (for money-moving routes) runs the handler once per Idempotency-Key. */
export function guarded({ contextOf, idempotency, audit }) {
  return function route(permission, handler, { idempotent = false, scope } = {}) {
    return wrap(async (req, res) => {
      const ctx = contextOf(req);
      req.payCtx = ctx;
      try {
        assertCan(ctx, permission);
      } catch (err) {
        await audit.record({ ctx, action: `refused:${req.method} ${req.route?.path ?? req.path}`, outcome: 'refused', details: { permission } });
        throw err;
      }
      if (!idempotent) {
        const out = unpack(await handler(req, ctx));
        if (out.status === 204) return res.status(204).end();
        return sendDoc(res, out.body, out.status);
      }
      const result = await idempotency.run({
        key: req.get('idempotency-key'),
        scope: `${scope ?? req.route?.path}:${ctx.actor.id ?? ''}:${JSON.stringify(req.params)}`,
        body: req.body ?? null,
        fn: async () => unpack(await handler(req, ctx)),
      });
      if (result.replayed) res.set('Idempotent-Replayed', 'true');
      return sendDoc(res, result.body, result.status);
    });
  };
}
