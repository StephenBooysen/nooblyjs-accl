// Platform Key Value stores (spec 8.7, where the platform runs them itself: decision of 2026-11-22). A tenant's store
// on a local site is one Valkey container on the tenant's own Docker network (runtime-local `stores`), answering on a
// private name only that network resolves, with a password; in a cloud region the mock stands in until the Memorystore
// and ElastiCache adapters (8.7.2, 8.7.3). A workload reaches one by linking it: `{ key: 'REDIS_URL', link: { keyvalue:
// '<name>' } }`. Locally the keys live in memory only: no persistence, no backups (R3's default).
//
// Records: platform-keyvalue/<tenant>/<name>.md; the password is in the secrets store (passwordRef).
import crypto from 'node:crypto';
import { notFound, conflict, unprocessable, quota } from '../util/errors.js';
import { isTenantId, isWorkloadName, internalHost } from './names.js';

export const KEYVALUE_OPERATIONS = ['keyvalue.create', 'keyvalue.update', 'keyvalue.delete'];
export const EVICTIONS = ['allkeys-lru', 'allkeys-lfu', 'volatile-lru', 'volatile-ttl', 'noeviction'];
export const KEYVALUE_LIMITS = { memoryMb: { min: 64, max: 16_384 }, connections: { min: 10, max: 10_000 }, perTenant: 20, nameMax: 40 };
const DIR = 'platform-keyvalue';

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.host
 * @param {object} o.operations
 * @param {object} o.secrets
 * @param {object|null} o.runtime        the local runtime's `stores` (or null without local sites)
 * @param {(region: string) => boolean} o.isLocal
 * @param {(region: string) => boolean} o.isRegion
 * @param {(tenantId: string, name: string) => object} o.labelsFor
 * @param {(type: string, payload: object) => void} [o.emitRaw]
 * @param {() => number} o.now
 */
export function createKeyValue({ store, host, operations, secrets, runtime = null, isLocal, isRegion, labelsFor, emitRaw = () => {}, now }) {
  const iso = () => new Date(now()).toISOString();
  const file = (t, n) => [DIR, t, `${n}.md`];
  const resourceOf = (t, n) => ({ type: 'keyvalue', tenant: t, name: n });
  const emit = (type, payload, actor) => {
    host.events.emit(type, { resource: resourceOf(payload.tenantId, payload.keyvalue), ...payload }, { actor: actor?.id ?? null });
    try {
      emitRaw(type, payload);
    } catch { /* a listener failed */ }
  };
  const audit = (actor, action, t, n, extra = {}) => host.audit.record({ actor: actor?.id ?? null, action, target: `keyvalue:${t}/${n}`, tenantId: t, ...extra });
  const actorOf = (actor) => (actor && typeof actor === 'object' && actor.id ? { id: String(actor.id), name: String(actor.name ?? actor.id), kind: actor.kind ?? 'person' } : null);
  const need = (t) => {
    if (!isTenantId(t)) throw unprocessable('A tenant id is up to 64 letters, digits, dots, hyphens and underscores.', { fields: { tenantId: 'Send the tenant\'s id.' } });
  };

  const repo = {
    async get(t, n) {
      need(t);
      if (!isWorkloadName(n)) return null;
      const doc = await store.readDoc(file(t, n));
      return doc && doc.data.tenantId === t ? doc.data : null;
    },
    async list(t) {
      need(t);
      const out = [];
      for (const f of (await store.list([DIR, t])) ?? []) {
        if (!f.endsWith('.md')) continue;
        const doc = await store.readDoc([DIR, t, f]).catch(() => null);
        if (doc?.data?.tenantId === t && doc.data.name) out.push(doc.data);
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    write: (t, rec) => store.writeDoc(file(t, rec.name), { ...rec, tenantId: t }, ''),
    update: (t, n, fn) => store.withLock(file(t, n), async () => {
      const doc = await store.readDoc(file(t, n));
      const next = fn(doc?.data ?? null);
      if (!next) return null;
      await store.writeDoc(file(t, n), { ...next, tenantId: t, name: n }, '');
      return next;
    }),
    remove: (t, n) => store.remove(file(t, n)),
  };

  function checkPlan(p = {}, fields) {
    const memoryMb = Number(p.memoryMb ?? 256);
    const connections = Number(p.connections ?? 100);
    const eviction = p.eviction ?? 'allkeys-lru';
    if (!Number.isInteger(memoryMb) || memoryMb < KEYVALUE_LIMITS.memoryMb.min || memoryMb > KEYVALUE_LIMITS.memoryMb.max) fields['plan.memoryMb'] = 'From 64 MB to 16 GB.';
    if (!Number.isInteger(connections) || connections < KEYVALUE_LIMITS.connections.min || connections > KEYVALUE_LIMITS.connections.max) fields['plan.connections'] = 'From 10 to 10,000 connections.';
    if (!EVICTIONS.includes(eviction)) fields['plan.eviction'] = `One of ${EVICTIONS.join(', ')}.`;
    return { memoryMb, connections, eviction };
  }
  const view = (kv) => {
    if (!kv) return null;
    const { passwordRef: _p, ...rest } = kv;
    return { ...rest, hasPassword: Boolean(kv.passwordRef) };
  };
  async function mustGet(t, n) {
    const kv = await repo.get(t, n);
    if (!kv) throw notFound(`No Key Value store ${n}.`);
    return kv;
  }
  async function setStatus(t, n, status, patch = {}) {
    const next = await repo.update(t, n, (d) => d && { ...d, ...patch, status, updatedAt: iso() });
    if (next) emit('infrastructure.keyvalue.status', { tenantId: t, keyvalue: n, status, ...(patch.reason ? { reason: patch.reason } : {}) });
    return next;
  }
  const activeOp = async (t, n) => (await operations.list({ resource: `keyvalue:${t}/${n}`, status: 'active' }))[0] ?? null;

  const startStep = {
    key: 'start',
    label: 'Start the store on the tenant\'s network',
    async run(ctx) {
      const t = ctx.op.tenant;
      const kv = await repo.get(t, ctx.op.resource.name);
      let passwordRef = kv.passwordRef;
      if (!passwordRef) passwordRef = await secrets.put('platform-keyvalue-password', crypto.randomBytes(24).toString('base64url'));
      if (isLocal(kv.region)) {
        if (!runtime) throw new Error('This site has no servers for a Key Value store.');
        const r = await runtime.run({
          tenantId: t, name: kv.name, labels: await labelsFor(t, `kv-${kv.name}`), region: kv.region, memoryMb: kv.plan.memoryMb, eviction: kv.plan.eviction,
          connections: kv.plan.connections, password: await secrets.get(passwordRef), log: (text) => ctx.log(text),
        });
        await repo.update(t, kv.name, (d) => d && { ...d, passwordRef, host: r.host, port: r.port, server: r.server });
      } else {
        await repo.update(t, kv.name, (d) => d && { ...d, passwordRef, host: `${kv.name}.${t}.keyvalue.mock`, port: 6379 });
        await ctx.log('Started (mock cloud)');
      }
      return {};
    },
  };
  operations.define('keyvalue.create', {
    label: (op) => `Create Key Value ${op.resource.name} (${op.tenant})`,
    verb: 'Creating',
    steps: [startStep],
    succeeded: async (ctx) => {
      await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available', { reason: null, availableAt: iso() });
      await audit(ctx.op.requestedBy, 'keyvalue.created', ctx.op.tenant, ctx.op.resource.name);
    },
    failed: async (ctx, err) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'failed', { reason: err?.message ?? String(err) }); },
    cancelled: async (ctx) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'failed', { reason: 'Cancelled.' }); },
  });
  operations.define('keyvalue.update', {
    label: (op) => `Change Key Value ${op.resource.name} (${op.tenant})`,
    verb: 'Changing',
    steps: [startStep],
    succeeded: async (ctx) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available', { reason: null }); },
    failed: async (ctx, err) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'failed', { reason: err?.message ?? String(err) }); },
  });
  operations.define('keyvalue.delete', {
    label: (op) => `Delete Key Value ${op.resource.name} (${op.tenant})`,
    verb: 'Deleting',
    steps: [{
      key: 'remove',
      label: 'Stop and remove the store',
      async run(ctx) {
        const t = ctx.op.tenant;
        const kv = await repo.get(t, ctx.op.resource.name);
        if (!kv) return {};
        if (isLocal(kv.region) && runtime) await runtime.remove({ tenantId: t, name: kv.name });
        if (kv.passwordRef) await secrets.remove(kv.passwordRef).catch(() => {});
        await repo.remove(t, kv.name);
        await ctx.log(`Removed ${kv.name} and its keys`);
        return {};
      },
    }],
    succeeded: async (ctx) => {
      emit('infrastructure.keyvalue.deleted', { tenantId: ctx.op.tenant, keyvalue: ctx.op.resource.name }, ctx.op.requestedBy);
      await audit(ctx.op.requestedBy, 'keyvalue.deleted', ctx.op.tenant, ctx.op.resource.name);
    },
    failed: async (ctx, err) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available', { reason: `Not deleted: ${err?.message ?? err}` }); },
  });

  const api = {
    /** A new store. spec: { name, region, plan: { memoryMb, connections, eviction } }. → { keyvalue, operation } */
    async create(t, spec = {}, { actor } = {}) {
      need(t);
      const by = actorOf(actor);
      const fields = {};
      if (!isWorkloadName(spec.name) || spec.name.length > KEYVALUE_LIMITS.nameMax) fields.name = 'Lower-case letters, digits and hyphens, starting with a letter; up to 40.';
      if (!isRegion(spec.region)) fields.region = 'A region the platform runs.';
      const plan = checkPlan(spec.plan, fields);
      if (Object.keys(fields).length) throw unprocessable('Check the Key Value store.', { fields });
      if (await repo.get(t, spec.name)) throw conflict(`There is a Key Value store called ${spec.name} already.`, { fields: { name: 'Taken.' } });
      if ((await repo.list(t)).length >= KEYVALUE_LIMITS.perTenant) throw quota(`At most ${KEYVALUE_LIMITS.perTenant} Key Value stores per tenant.`);
      const record = {
        name: spec.name, engine: 'valkey', version: '8.1', region: spec.region, plan, persistence: false, host: null, port: null, passwordRef: null,
        status: 'creating', createdAt: iso(), createdBy: by,
      };
      await repo.write(t, record);
      const operation = await operations.start('keyvalue.create', { resource: resourceOf(t, spec.name), tenant: t, input: {}, person: by });
      emit('infrastructure.keyvalue.status', { tenantId: t, keyvalue: spec.name, status: 'creating' }, by);
      return { keyvalue: view(record), operation };
    },
    list: async (t) => (await repo.list(t)).map(view),
    get: async (t, n) => view(await mustGet(t, n)),
    /** The connection string (R4); the launcher audits who sees it. → { url, host, port, password } */
    async connection(t, n) {
      const kv = await mustGet(t, n);
      if (kv.status !== 'available' || !kv.passwordRef) throw conflict(`${n} is ${kv.status}: it has no connection string yet.`);
      const password = await secrets.get(kv.passwordRef);
      const scheme = isLocal(kv.region) ? 'redis' : 'rediss';
      return { url: `${scheme}://default:${encodeURIComponent(password)}@${kv.host}:${kv.port}`, host: kv.host, port: kv.port, password };
    },
    /** → { memoryUsedMb (Docker's count, locally), memoryMb, connections (the limit), running, at } */
    async stats(t, n) {
      const kv = await mustGet(t, n);
      const s = isLocal(kv.region) && runtime ? await runtime.status({ tenantId: t, name: n }) : null;
      return { memoryUsedMb: s?.memoryMb ?? null, memoryMb: kv.plan.memoryMb, connections: kv.plan.connections, running: s ? s.running : kv.status === 'available', at: s?.at ?? iso() };
    },
    /** A new size, client limit or eviction policy: the store starts again with them (its keys are lost locally). */
    async update(t, n, changes = {}, { actor } = {}) {
      const kv = await mustGet(t, n);
      const fields = {};
      const plan = checkPlan({ ...kv.plan, ...(changes.plan ?? {}) }, fields);
      if (Object.keys(fields).length) throw unprocessable('Check the Key Value store.', { fields });
      if (kv.status !== 'available') throw conflict(`${n} is ${kv.status}.`);
      if (await activeOp(t, n)) throw conflict(`${n} is busy: wait for its operation to finish.`);
      if (JSON.stringify(plan) === JSON.stringify(kv.plan)) return { keyvalue: view(kv), operation: null };
      await repo.update(t, n, (d) => d && { ...d, plan, status: 'updating' });
      const operation = await operations.start('keyvalue.update', { resource: resourceOf(t, n), tenant: t, input: {}, person: actorOf(actor) });
      await audit(actorOf(actor), 'keyvalue.updated', t, n, { plan });
      return { keyvalue: view(await repo.get(t, n)), operation };
    },
    async remove(t, n, { actor } = {}) {
      const kv = await mustGet(t, n);
      if (kv.status === 'deleting') throw conflict(`${n} is being deleted.`);
      if (await activeOp(t, n)) throw conflict(`${n} is busy: wait for its operation to finish.`);
      await setStatus(t, n, 'deleting');
      return { operation: await operations.start('keyvalue.delete', { resource: resourceOf(t, n), tenant: t, input: {}, person: actorOf(actor) }) };
    },
    /** A linked variable's value: the store's URL on its private name (only the tenant's network resolves it). */
    async linkValue(t, n, { region }) {
      const kv = await repo.get(t, n);
      if (!kv) throw notFound(`The linked Key Value store ${n} does not exist.`);
      if (kv.region !== region) throw unprocessable(`The linked Key Value store ${n} is in ${kv.region}, not ${region}.`);
      return (await api.connection(t, n)).url;
    },
    /** The private name a store answers on (for screens before it is up). */
    hostOf: (t, n) => internalHost(t, `${n}-kv`),
  };
  return api;
}
