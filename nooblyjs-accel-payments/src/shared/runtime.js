// The small services every module shares: the clock, events (spec §8), the audit trail, roles (steering §5) and
// idempotency (steering §3.3).
import { createHash } from 'node:crypto';
import { forbidden, invalid, conflict, PayError } from './errors.js';
import { newId } from './ids.js';

// ---- clock -------------------------------------------------------------------------------------------------------

export const systemClock = { now: () => Date.now() };

/** A clock tests move by hand (dunning and period close). */
export function createTestClock(start = '2026-01-01T00:00:00.000Z') {
  let t = typeof start === 'number' ? start : Date.parse(start);
  return {
    now: () => t,
    set(at) { t = typeof at === 'number' ? at : Date.parse(at); },
    advance(ms) { t += ms; },
  };
}

// ---- events ------------------------------------------------------------------------------------------------------

export const EVENT_TYPES = [
  'pay.account.created', 'pay.account.updated', 'pay.account.delinquent', 'pay.account.reinstated',
  'pay.method.added', 'pay.method.removed', 'pay.method.expiring',
  'pay.subscription.created', 'pay.subscription.changed', 'pay.subscription.cancelled', 'pay.subscription.past_due',
  'pay.invoice.finalized', 'pay.invoice.paid', 'pay.invoice.payment_failed', 'pay.invoice.voided', 'pay.invoice.uncollectible',
  'pay.payment.succeeded', 'pay.payment.failed', 'pay.payment.requires_action',
  'pay.refund.succeeded', 'pay.credit_note.created', 'pay.price.created', 'pay.reconciliation.issue',
];

/** Events on the shared emitter, mirrored to core notifying topic pay.{module}; payloads carry ids and amounts only. */
export function createEvents({ eventEmitter, notifying, clock, log }) {
  const local = new Map();
  let closed = false;
  return {
    emit(type, data) {
      if (closed) return null;
      const event = { id: newId('evt'), type, at: new Date(clock.now()).toISOString(), data };
      try {
        eventEmitter.emit(type, event);
        eventEmitter.emit('pay.*', event);
      } catch (err) {
        log?.warn?.(`[accel-payments] a listener of ${type} failed: ${err.message}`);
      }
      for (const fn of [...(local.get(type) ?? []), ...(local.get('*') ?? [])]) {
        Promise.resolve().then(() => fn(event)).catch((err) => log?.warn?.(`[accel-payments] a listener of ${type} failed: ${err.message}`));
      }
      try {
        notifying?.publish?.(`pay.${type.split('.')[1]}`, event);
      } catch { /* notifying is a mirror */ }
      return event;
    },
    /** Listens to one type, or '*' for all. Returns an unsubscribe function. */
    on(type, fn) {
      if (!local.has(type)) local.set(type, new Set());
      local.get(type).add(fn);
      return () => local.get(type)?.delete(fn);
    },
    close() {
      closed = true;
      local.clear();
    },
  };
}

// ---- audit -------------------------------------------------------------------------------------------------------

/** Every write and every refusal (steering §3.5, §6). Amounts kept; card data never present. */
export function createAudit({ repo, clock }) {
  return {
    async record({ ctx, action, ref = null, details = {}, outcome = 'ok' }) {
      return repo.insert({
        id: newId('aud'),
        at: new Date(clock.now()).toISOString(),
        actor: ctx?.actor ?? { type: 'system', id: 'system' },
        action, ref, details, outcome,
      });
    },
    list({ refId, action, limit = 100 } = {}) {
      return repo.list((a) => (!refId || a.ref?.id === refId) && (!action || a.action === action))
        .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
    },
  };
}

// ---- roles -------------------------------------------------------------------------------------------------------

export const ROLES = ['admin', 'finance', 'support', 'readonly', 'service'];

/** Permission → roles (steering §5). */
export const PERMISSIONS = {
  read: ['admin', 'finance', 'support', 'readonly', 'service'],
  'catalogue.write': ['admin', 'finance'],
  'accounts.write': ['admin', 'finance', 'service'],
  'methods.write': ['admin', 'service'],
  'subscriptions.write': ['admin', 'finance', 'service'],
  'usage.write': ['admin', 'service'],
  'invoices.write': ['admin', 'finance'],
  'invoices.send': ['admin', 'finance', 'support'],
  'refunds.write': ['admin', 'finance', 'support'],
  'credit_notes.write': ['admin', 'finance'],
  settings: ['admin'],
};

export const SYSTEM = Object.freeze({ actor: { type: 'system', id: 'system', name: 'System' }, roles: ['admin'], system: true });

export function systemContext(job = 'system') {
  return { actor: { type: 'system', id: job, name: job }, roles: ['admin'], system: true };
}

export const can = (ctx, permission) => Boolean(ctx?.system) || (PERMISSIONS[permission] ?? []).some((r) => ctx?.roles?.includes(r));

export function assertCan(ctx, permission) {
  if (!can(ctx, permission)) throw forbidden();
}

/** The context of an HTTP request: roles from the host's resolver, or from an API key (role `service`). */
export function contextResolver({ roleResolver, apiKeys = [] }) {
  return function contextOf(req) {
    const header = req.get?.('authorization') ?? '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (bearer) {
      const match = apiKeys.find((k) => k.key === bearer);
      if (match) return { actor: { type: 'service', id: match.name ?? 'api-key', name: match.name ?? 'API key' }, roles: match.roles ?? ['service'] };
    }
    const roles = (roleResolver?.(req) ?? []).filter((r) => ROLES.includes(r));
    const who = req.person ?? req.user ?? null;
    return { actor: { type: who ? 'person' : 'anonymous', id: who?.id ?? null, name: who?.name ?? who?.email ?? null }, roles };
  };
}

// ---- idempotency -------------------------------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;
export const hashOf = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

/**
 * Remembers each money-moving request by its key for 24 hours: the same key and body returns the first answer; the same
 * key with a different body is refused.
 */
export function createIdempotency({ repo, clock }) {
  async function sweep() {
    const now = clock.now();
    for (const e of repo.list((x) => Date.parse(x.expiresAt) < now)) await repo.remove(e.id);
  }
  return {
    /**
     * @param {{ key: string, scope: string, body: unknown, fn: () => Promise<{ status: number, body: unknown }> }} o
     * @returns {Promise<{ status: number, body: unknown, replayed: boolean }>}
     */
    async run({ key, scope, body, fn }) {
      if (typeof key !== 'string' || !/^[\x21-\x7e]{8,255}$/.test(key)) {
        throw invalid('Send an Idempotency-Key header: 8 to 255 visible characters, new for each change.', [{ path: 'Idempotency-Key', message: 'Required.' }]);
      }
      const id = `idem_${hashOf(`${scope}\n${key}`).slice(0, 40)}`;
      const requestHash = hashOf(body);
      const existing = repo.get(id);
      if (existing && Date.parse(existing.expiresAt) >= clock.now()) {
        if (existing.requestHash !== requestHash) throw new PayError(422, 'idempotency_key_reused', 'This Idempotency-Key was used for a different request.');
        if (existing.state === 'pending') throw conflict('A request with this Idempotency-Key is still being processed.');
        return { ...existing.response, replayed: true };
      }
      if (existing) await repo.remove(id);
      await repo.insert({ id, key, scope, requestHash, state: 'pending', response: null, expiresAt: new Date(clock.now() + DAY).toISOString() });
      let response;
      try {
        response = await fn();
      } catch (err) {
        if (err instanceof PayError && err.status < 500) {
          response = { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details ?? [] } } };
        } else {
          await repo.remove(id);
          throw err;
        }
      }
      await repo.update(id, (e) => ({ ...e, state: 'done', response }));
      if (Math.random() < 0.05) sweep().catch(() => {});
      return { ...response, replayed: false };
    },
    sweep,
  };
}
