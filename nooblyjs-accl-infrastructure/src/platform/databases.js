// Platform databases (spec 8.6, where the platform runs Postgres itself: decision of 2026-11-22). A launcher's tenant
// gets Postgres databases through `services.platform.databases`, with the same operation and event model as workloads.
// On a local site the database lives on the site's Postgres server (postgres-local.js) and is reached through the agent's
// relay on the tenant's network; in a cloud region the mock engine stands in until the Cloud SQL and RDS adapters
// (8.6.2, 8.6.3). A workload reaches one by linking it: `{ key: 'DATABASE_URL', link: { database: '<name>' } }`.
//
// Records: platform-databases/<tenant>/<name>.md; backups: platform-databases/<tenant>/<name>/backups/<id>.dump. The
// password is in the secrets store (passwordRef), never in the record.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId, isGeneratedId } from '../util/ids.js';
import { notFound, conflict, unprocessable, quota } from '../util/errors.js';
import { isTenantId, isWorkloadName } from './names.js';
import { identifierOf } from './postgres-local.js';

export const DATABASE_OPERATIONS = ['database.create', 'database.delete', 'database.backup', 'database.restore'];
export const DATABASE_STATUSES = ['creating', 'available', 'failed', 'deleting'];
export const DATABASE_LIMITS = { connections: { min: 5, max: 500 }, storageMb: { min: 256, max: 1_000_000 }, perTenant: 20, keepBackups: 7 };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIR = 'platform-databases';

/** A mock engine: the cloud regions' stand-in (spec 8.6 Design, Mock), with the same calls as the local one. */
export function createMockPostgres() {
  const dbs = new Map();
  return {
    server: { host: 'postgres.mock', port: 5432 },
    async check() { return { ok: true, version: '16.4 (mock)' }; },
    async create({ identifier, connections }) {
      const password = crypto.randomBytes(24).toString('base64url');
      dbs.set(identifier, { connections, bytes: 7_700_000, rows: [] });
      return { database: identifier, user: identifier, password };
    },
    async resetPassword() { return crypto.randomBytes(24).toString('base64url'); },
    async setConnections({ identifier, connections }) { if (dbs.has(identifier)) dbs.get(identifier).connections = connections; },
    async drop({ identifier }) { dbs.delete(identifier); },
    async stats(ids) { return new Map(ids.filter((i) => dbs.has(i)).map((i) => [i, { bytes: dbs.get(i).bytes, connections: 0, limit: dbs.get(i).connections }])); },
    async backup({ identifier, file }) {
      const body = `mock dump of ${identifier} at ${new Date().toISOString()}\n`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
      return Buffer.byteLength(body);
    },
    async restore({ identifier }) { if (!dbs.has(identifier)) throw new Error(`no database ${identifier}`); },
  };
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.host            events, audit
 * @param {object} o.operations
 * @param {object} o.secrets
 * @param {object|null} o.local      the local site's engine (createLocalPostgres) or null
 * @param {(region: string) => boolean} o.isLocal
 * @param {(region: string) => boolean} o.isRegion   a region the platform knows (cloud or local)
 * @param {(tenantId: string) => Promise<void>} o.refreshRelays   tells the tenant's relays which databases they reach
 * @param {(type: string, payload: object) => void} [o.emitRaw]
 * @param {() => number} o.now
 * @param {object} o.log
 * @param {number} [o.checkMs]       how often due backups are looked for (0: never; tests)
 */
export function createDatabases({ store, host, operations, secrets, local = null, isLocal, isRegion, refreshRelays = async () => {}, emitRaw = () => {}, now, log, checkMs = 60_000 }) {
  const mock = createMockPostgres();
  const engineOf = (db) => (isLocal(db.region) ? local : mock);
  const iso = () => new Date(now()).toISOString();
  const file = (t, n) => [DIR, t, `${n}.md`];
  const backupFile = (t, n, id) => [DIR, t, n, 'backups', `${id}.dump`];
  const resourceOf = (t, n) => ({ type: 'database', tenant: t, name: n });
  const emit = (type, payload, actor) => {
    host.events.emit(type, { resource: resourceOf(payload.tenantId, payload.database), ...payload }, { actor: actor?.id ?? null });
    try {
      emitRaw(type, payload);
    } catch { /* a listener failed */ }
  };
  const audit = (actor, action, t, n, extra = {}) => host.audit.record({ actor: actor?.id ?? null, action, target: `database:${t}/${n}`, tenantId: t, ...extra });

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
    remove: async (t, n) => {
      await store.remove([DIR, t, n]);
      await store.remove(file(t, n));
    },
    async tenants() {
      return ((await store.list([DIR], { dirs: true })) ?? []).filter(isTenantId);
    },
  };

  const actorOf = (actor) => (actor && typeof actor === 'object' && actor.id ? { id: String(actor.id), name: String(actor.name ?? actor.id), kind: actor.kind ?? 'person' } : null);
  const activeOp = async (t, n) => (await operations.list({ resource: `database:${t}/${n}`, status: 'active' }))[0] ?? null;

  function checkPlan(plan, fields) {
    const p = plan ?? {};
    const c = Number(p.connections ?? 20);
    const s = Number(p.storageMb ?? 1024);
    if (!Number.isInteger(c) || c < DATABASE_LIMITS.connections.min || c > DATABASE_LIMITS.connections.max) fields['plan.connections'] = `From ${DATABASE_LIMITS.connections.min} to ${DATABASE_LIMITS.connections.max} connections.`;
    if (!Number.isInteger(s) || s < DATABASE_LIMITS.storageMb.min || s > DATABASE_LIMITS.storageMb.max) fields['plan.storageMb'] = `From ${DATABASE_LIMITS.storageMb.min} MB to 1 TB (decimal megabytes).`;
    return { connections: c, storageMb: s };
  }

  /** What a launcher sees: no password, no admin details. */
  function view(db) {
    if (!db) return null;
    const { passwordRef: _p, ...rest } = db;
    return { ...rest, hasPassword: Boolean(db.passwordRef) };
  }

  async function mustGet(t, n) {
    const db = await repo.get(t, n);
    if (!db) throw notFound(`No database ${n}.`);
    return db;
  }

  async function setStatus(t, n, status, patch = {}) {
    const next = await repo.update(t, n, (d) => d && { ...d, ...patch, status, updatedAt: iso() });
    if (next) emit('infrastructure.database.status', { tenantId: t, database: n, status, ...(patch.reason ? { reason: patch.reason } : {}) });
    return next;
  }

  // ------------------------------------------------------------ operations
  const dbOf = (ctx) => repo.get(ctx.op.tenant, ctx.op.resource.name);
  const createStep = {
    key: 'create',
    label: 'Create the database and its user',
    async run(ctx) {
      const db = await dbOf(ctx);
      const engine = engineOf(db);
      if (!engine) throw new Error('This site has no Postgres server. An operator sets local.postgres.url.');
      const creds = await engine.create({ identifier: db.identifier, connections: db.plan.connections });
      const passwordRef = await secrets.put('platform-database-password', creds.password);
      if (db.passwordRef) await secrets.remove(db.passwordRef).catch(() => {});
      await repo.update(ctx.op.tenant, db.name, (d) => d && { ...d, passwordRef, user: creds.user, database: creds.database });
      await ctx.log(`Created database ${creds.database} owned by its own login role, at most ${db.plan.connections} connections`);
      return {};
    },
  };
  const openStep = {
    key: 'open',
    label: 'Open it to the tenant\'s network',
    async run(ctx) {
      const db = await dbOf(ctx);
      if (isLocal(db.region)) {
        await refreshRelays(ctx.op.tenant);
        await ctx.log('Its tenant\'s containers reach it through the relay on their own network; no one else can');
      } else {
        await ctx.log('Private to the tenant (mock cloud)');
      }
      return {};
    },
  };
  const ready = async (ctx) => {
    await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available', { reason: null, availableAt: iso() });
    await audit(ctx.op.requestedBy, 'database.created', ctx.op.tenant, ctx.op.resource.name);
  };
  const failed = async (ctx, err) => {
    await setStatus(ctx.op.tenant, ctx.op.resource.name, 'failed', { reason: err?.message ?? String(err) });
  };

  operations.define('database.create', {
    label: (op) => `Create database ${op.resource.name} (${op.tenant})`,
    verb: 'Creating',
    steps: [createStep, openStep],
    succeeded: ready,
    failed,
    cancelled: failed,
  });

  operations.define('database.restore', {
    label: (op) => `Restore ${op.input.from} into ${op.resource.name} (${op.tenant})`,
    verb: 'Restoring',
    steps: [createStep, {
      key: 'load',
      label: 'Load the backup',
      async run(ctx) {
        const db = await dbOf(ctx);
        const src = store.resolve(backupFile(ctx.op.tenant, ctx.input.from, ctx.input.backupId));
        await engineOf(db).restore({ identifier: db.identifier, file: src });
        await ctx.log(`Loaded the backup of ${ctx.input.from} taken ${ctx.input.backupAt}`);
        return {};
      },
    }, openStep],
    succeeded: ready,
    failed,
    cancelled: failed,
  });

  operations.define('database.delete', {
    label: (op) => `Delete database ${op.resource.name} (${op.tenant})`,
    verb: 'Deleting',
    steps: [{
      key: 'drop',
      label: 'End its connections and drop it',
      async run(ctx) {
        const db = await dbOf(ctx);
        if (!db) return {};
        const engine = engineOf(db);
        if (engine && db.database) await engine.drop({ identifier: db.identifier });
        if (db.passwordRef) await secrets.remove(db.passwordRef).catch(() => {});
        await repo.remove(ctx.op.tenant, db.name);
        if (isLocal(db.region)) await refreshRelays(ctx.op.tenant);
        await ctx.log(`Dropped ${db.identifier} and its role; removed its backups`);
        return {};
      },
    }],
    succeeded: async (ctx) => {
      emit('infrastructure.database.deleted', { tenantId: ctx.op.tenant, database: ctx.op.resource.name }, ctx.op.requestedBy);
      await audit(ctx.op.requestedBy, 'database.deleted', ctx.op.tenant, ctx.op.resource.name);
    },
    failed: async (ctx, err) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available', { reason: `Not deleted: ${err?.message ?? err}` }); },
    cancelled: async (ctx) => { await setStatus(ctx.op.tenant, ctx.op.resource.name, 'available'); },
  });

  operations.define('database.backup', {
    label: (op) => `Back up ${op.resource.name} (${op.tenant})`,
    verb: 'Backing up',
    steps: [{
      key: 'dump',
      label: 'Dump the database',
      async run(ctx) {
        const db = await dbOf(ctx);
        const id = ctx.input.backupId;
        const target = store.resolve(backupFile(ctx.op.tenant, db.name, id));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const bytes = await engineOf(db).backup({ identifier: db.identifier, file: target });
        const at = iso();
        let dropped = [];
        await repo.update(ctx.op.tenant, db.name, (d) => {
          if (!d) return null;
          const list = [{ id, at, bytes, trigger: ctx.input.trigger ?? 'manual' }, ...(d.backups ?? [])];
          dropped = list.slice(DATABASE_LIMITS.keepBackups);
          return { ...d, backups: list.slice(0, DATABASE_LIMITS.keepBackups), lastBackupAt: at };
        });
        for (const old of dropped) await store.remove(backupFile(ctx.op.tenant, db.name, old.id)).catch(() => {});
        await ctx.log(`Backed up ${db.name}: ${bytes} bytes${dropped.length ? `; removed ${dropped.length} older backup${dropped.length === 1 ? '' : 's'}` : ''}`);
        return {};
      },
    }],
    succeeded: async (ctx) => {
      emit('infrastructure.database.backed_up', { tenantId: ctx.op.tenant, database: ctx.op.resource.name, backupId: ctx.input.backupId }, ctx.op.requestedBy);
    },
    failed: async (ctx, err) => {
      emit('infrastructure.database.backup_failed', { tenantId: ctx.op.tenant, database: ctx.op.resource.name, reason: err?.message ?? String(err) }, ctx.op.requestedBy);
    },
  });

  // ------------------------------------------------------------ daily backups
  async function dueBackups() {
    const t0 = new Date(now());
    const hhmm = t0.toISOString().slice(11, 16);
    const today = t0.toISOString().slice(0, 10);
    for (const t of await repo.tenants()) {
      for (const db of await repo.list(t)) {
        if (db.status !== 'available' || !db.backupTime) continue;
        if (hhmm < db.backupTime || String(db.lastBackupAt ?? '').slice(0, 10) === today) continue;
        if (await activeOp(t, db.name)) continue;
        await operations.start('database.backup', { resource: resourceOf(t, db.name), tenant: t, input: { backupId: newId('bak'), trigger: 'schedule' }, person: null })
          .catch((err) => log.warn(`daily backup of ${t}/${db.name}: ${err.message}`));
      }
    }
  }
  const timer = checkMs ? setInterval(() => dueBackups().catch((err) => log.warn(`backups: ${err.message}`)), checkMs) : null;
  timer?.unref?.();

  // ------------------------------------------------------------ the API
  const api = {
    /**
     * A new database. spec: { name, engine: 'postgres', region, plan: { connections, storageMb }, backupTime: 'HH:MM' UTC }.
     * → { database, operation }
     */
    async create(t, spec = {}, { actor } = {}) {
      need(t);
      const by = actorOf(actor);
      const fields = {};
      if (!isWorkloadName(spec.name)) fields.name = 'Lower-case letters, digits and hyphens, starting with a letter (a DNS label).';
      if ((spec.engine ?? 'postgres') !== 'postgres') fields.engine = 'postgres is the engine for now.';
      if (!isRegion(spec.region)) fields.region = 'A region the platform runs.';
      const plan = checkPlan(spec.plan, fields);
      const backupTime = spec.backupTime === undefined ? '03:00' : spec.backupTime;
      if (backupTime !== null && !TIME.test(String(backupTime))) fields.backupTime = 'HH:MM in UTC, or null for no daily backup.';
      if (Object.keys(fields).length) throw unprocessable('Check the database.', { fields });
      if (isLocal(spec.region) && !local) throw unprocessable('This site has no Postgres server yet: an operator sets local.postgres.url.', { fields: { region: 'No Postgres server on this site.' } });
      if (await repo.get(t, spec.name)) throw conflict(`There is a database called ${spec.name} already.`, { fields: { name: 'Taken.' } });
      if ((await repo.list(t)).length >= DATABASE_LIMITS.perTenant) throw quota(`At most ${DATABASE_LIMITS.perTenant} databases per tenant.`);
      const engine = isLocal(spec.region) ? local : mock;
      const record = {
        name: spec.name, engine: 'postgres', version: (await engine.check().catch(() => ({ version: null }))).version, region: spec.region, plan, backupTime,
        identifier: identifierOf(t, spec.name), host: engine.server.host, port: engine.server.port, database: null, user: null, passwordRef: null,
        status: 'creating', backups: [], lastBackupAt: null, createdAt: iso(), createdBy: by,
      };
      await repo.write(t, record);
      const operation = await operations.start('database.create', { resource: resourceOf(t, spec.name), tenant: t, input: {}, person: by });
      emit('infrastructure.database.status', { tenantId: t, database: spec.name, status: 'creating' }, by);
      return { database: view(record), operation };
    },

    async list(t) {
      return (await repo.list(t)).map(view);
    },
    async get(t, n) {
      return view(await mustGet(t, n));
    },

    /**
     * The connection string and its parts (spec 8.6 R5). The launcher audits who sees it. On a local site it names the
     * server itself (for the operator's machine and the site's own network); a linked container gets the address of
     * the relay on its network instead (`relay`).
     */
    async connection(t, n, { relay = null } = {}) {
      const db = await mustGet(t, n);
      if (db.status !== 'available' || !db.passwordRef) throw conflict(`${n} is ${db.status}: it has no connection string yet.`);
      const password = await secrets.get(db.passwordRef);
      const host_ = relay?.host ?? (isLocal(db.region) ? db.host : `${n}.${t}.postgres.mock`);
      const port = relay?.port ?? db.port;
      const url = `postgres://${encodeURIComponent(db.user)}:${encodeURIComponent(password)}@${host_}:${port}/${encodeURIComponent(db.database)}${isLocal(db.region) ? '?sslmode=disable' : '?sslmode=require'}`;
      return { url, host: host_, port, database: db.database, user: db.user, password };
    },

    /** Size, connections and their limits now. → { bytes, connections, limitConnections, limitBytes, at } */
    async stats(t, n) {
      const db = await mustGet(t, n);
      const engine = engineOf(db);
      const s = engine && db.status === 'available' ? (await engine.stats([db.identifier]).catch(() => new Map())).get(db.identifier) : null;
      return { bytes: s?.bytes ?? null, connections: s?.connections ?? null, limitConnections: db.plan.connections, limitBytes: db.plan.storageMb * 1_000_000, at: iso() };
    },

    /** A new plan (connections apply at once; storage is the limit the meter shows) or backup time. */
    async update(t, n, changes = {}, { actor } = {}) {
      const db = await mustGet(t, n);
      const fields = {};
      const plan = changes.plan ? checkPlan({ ...db.plan, ...changes.plan }, fields) : db.plan;
      const backupTime = changes.backupTime === undefined ? db.backupTime : changes.backupTime;
      if (backupTime !== null && !TIME.test(String(backupTime))) fields.backupTime = 'HH:MM in UTC, or null for no daily backup.';
      if (Object.keys(fields).length) throw unprocessable('Check the database.', { fields });
      if (db.status !== 'available') throw conflict(`${n} is ${db.status}.`);
      if (plan.connections !== db.plan.connections) await engineOf(db).setConnections({ identifier: db.identifier, connections: plan.connections });
      const next = await repo.update(t, n, (d) => d && { ...d, plan, backupTime, updatedAt: iso() });
      await audit(actorOf(actor), 'database.updated', t, n, { plan, backupTime });
      return view(next);
    },

    async remove(t, n, { actor } = {}) {
      const db = await mustGet(t, n);
      const by = actorOf(actor);
      if (db.status === 'deleting') throw conflict(`${n} is being deleted.`);
      if (await activeOp(t, n)) throw conflict(`${n} is busy: wait for its operation to finish.`);
      await setStatus(t, n, 'deleting');
      const operation = await operations.start('database.delete', { resource: resourceOf(t, n), tenant: t, input: {}, person: by });
      return { operation };
    },

    /** Newest first: [{ id, at, bytes, trigger }]. */
    async backups(t, n) {
      return (await mustGet(t, n)).backups ?? [];
    },
    async backup(t, n, { actor } = {}) {
      const db = await mustGet(t, n);
      if (db.status !== 'available') throw conflict(`${n} is ${db.status}.`);
      if (await activeOp(t, n)) throw conflict(`${n} is busy: wait for its operation to finish.`);
      const backupId = newId('bak');
      const operation = await operations.start('database.backup', { resource: resourceOf(t, n), tenant: t, input: { backupId, trigger: 'manual' }, person: actorOf(actor) });
      return { backupId, operation };
    },
    /** A new database `into` from one of `n`'s backups. → { database, operation } */
    async restore(t, n, backupId, { into, actor } = {}) {
      const src = await mustGet(t, n);
      const b = isGeneratedId(backupId) ? (src.backups ?? []).find((x) => x.id === backupId) : null;
      if (!b) throw notFound(`No backup ${backupId} of ${n}.`);
      if (!isWorkloadName(into)) throw unprocessable('Name the new database.', { fields: { into: 'Lower-case letters, digits and hyphens.' } });
      if (await repo.get(t, into)) throw conflict(`There is a database called ${into} already.`, { fields: { into: 'Taken.' } });
      const by = actorOf(actor);
      const engine = engineOf(src);
      const record = {
        ...src, name: into, identifier: identifierOf(t, into), database: null, user: null, passwordRef: null, status: 'creating', backups: [], lastBackupAt: null,
        restoredFrom: { database: n, backupId, at: b.at }, createdAt: iso(), createdBy: by, host: engine.server.host, port: engine.server.port,
      };
      delete record.availableAt;
      delete record.reason;
      await repo.write(t, record);
      const operation = await operations.start('database.restore', { resource: resourceOf(t, into), tenant: t, input: { from: n, backupId, backupAt: b.at }, person: by });
      emit('infrastructure.database.status', { tenantId: t, database: into, status: 'creating' }, by);
      return { database: view(record), operation };
    },

    // ---- for the runtime and the operators
    /** The server identifiers of a tenant's available databases on the local site (the relay's list). */
    async allowList(t) {
      return (await repo.list(t)).filter((d) => isLocal(d.region) && d.status !== 'deleting' && d.database).map((d) => d.identifier);
    },
    /** A linked variable's value for a workload's container: the connection string through its relay. */
    async linkValue(t, n, { region, relay }) {
      const db = await repo.get(t, n);
      if (!db) throw notFound(`The linked database ${n} does not exist.`);
      if (db.region !== region) throw unprocessable(`The linked database ${n} is in ${db.region}, not ${region}.`);
      return (await api.connection(t, n, { relay })).url;
    },
    tenants: () => repo.tenants(),
    stop() {
      if (timer) clearInterval(timer);
    },
    dueBackups,
  };
  return api;
}
