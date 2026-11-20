// The platform layer's records (spec 8.1): workloads/<tenant>/<name>.md and workloads/<tenant>/<name>/deploys/<id>.md,
// whose body is the deploy's build and rollout log. Every call takes the tenant first and refuses to run without a
// valid one, so no code path can read or write a workload without saying whose it is. Records hold no tenant other
// than the folder they live in: a record whose tenantId disagrees with its folder is skipped.
import { isGeneratedId } from '../util/ids.js';
import { isTenantId, isWorkloadName } from './names.js';

const split = ({ body = '', ...data }) => [data, body];

function needTenant(tenantId) {
  if (!isTenantId(tenantId)) throw new TypeError(`A platform record needs a tenant id, not ${JSON.stringify(tenantId)}.`);
}

export function createPlatformRepos(store, { log }) {
  const workloadFile = (tenantId, name) => ['workloads', tenantId, `${name}.md`];
  const deployDir = (tenantId, name) => ['workloads', tenantId, name, 'deploys'];

  async function read(segments, tenantId) {
    const doc = await store.readDoc(segments);
    if (!doc) return null;
    if (doc.data.tenantId !== undefined && doc.data.tenantId !== tenantId) {
      log.warn(`skipped ${segments.join('/')}: it says tenant ${doc.data.tenantId}`);
      return null;
    }
    return { ...doc.data, body: doc.body };
  }

  async function readAll(dir, tenantId, key) {
    const out = [];
    for (const file of (await store.list(dir)) ?? []) {
      if (!file.endsWith('.md')) continue;
      try {
        const record = await read([...dir, file], tenantId);
        if (record?.[key]) out.push(record);
      } catch (err) {
        log.warn(`skipped ${dir.join('/')}/${file}: ${err.message}`);
      }
    }
    return out;
  }

  const workloads = {
    async list(tenantId) {
      needTenant(tenantId);
      return readAll(['workloads', tenantId], tenantId, 'name');
    },
    async get(tenantId, name) {
      needTenant(tenantId);
      return isWorkloadName(name) ? read(workloadFile(tenantId, name), tenantId) : null;
    },
    async write(tenantId, record) {
      needTenant(tenantId);
      if (!isWorkloadName(record?.name)) throw new TypeError(`not a workload name: ${record?.name}`);
      const [data, body] = split({ ...record, tenantId });
      await store.writeDoc(workloadFile(tenantId, record.name), data, body);
      return { ...record, tenantId };
    },
    /** Read-modify-write under the record's lock; `fn(current)` returns the new record, or nothing to leave it. */
    async update(tenantId, name, fn) {
      needTenant(tenantId);
      if (!isWorkloadName(name)) return null;
      const file = workloadFile(tenantId, name);
      return store.withLock(file, async () => {
        const next = await fn(await read(file, tenantId));
        if (!next) return null;
        const [data, body] = split({ ...next, tenantId, name });
        await store.writeDoc(file, data, body);
        return { ...next, tenantId, name };
      });
    },
    /** Removes the record and its deploys. */
    async remove(tenantId, name) {
      needTenant(tenantId);
      if (!isWorkloadName(name)) return;
      await store.remove(['workloads', tenantId, name]);
      await store.remove(workloadFile(tenantId, name));
    },
  };

  const deploys = {
    async list(tenantId, name) {
      needTenant(tenantId);
      if (!isWorkloadName(name)) return [];
      return readAll(deployDir(tenantId, name), tenantId, 'id');
    },
    async get(tenantId, name, id) {
      needTenant(tenantId);
      return isWorkloadName(name) && isGeneratedId(id) ? read([...deployDir(tenantId, name), `${id}.md`], tenantId) : null;
    },
    async write(tenantId, name, record) {
      needTenant(tenantId);
      if (!isWorkloadName(name) || !isGeneratedId(record?.id)) throw new TypeError(`not a deploy of ${name}: ${record?.id}`);
      const [data, body] = split({ ...record, tenantId, workload: name });
      await store.writeDoc([...deployDir(tenantId, name), `${record.id}.md`], data, body);
      return record;
    },
    async update(tenantId, name, id, fn) {
      needTenant(tenantId);
      if (!isWorkloadName(name) || !isGeneratedId(id)) return null;
      const file = [...deployDir(tenantId, name), `${id}.md`];
      return store.withLock(file, async () => {
        const next = await fn(await read(file, tenantId));
        if (!next) return null;
        const [data, body] = split({ ...next, tenantId, workload: name });
        await store.writeDoc(file, data, body);
        return next;
      });
    },
  };

  return {
    workloads,
    deploys,
    /** The tenants that have workloads (operators only: the Platform screen and the inventory). */
    async tenants() {
      return ((await store.list(['workloads'], { dirs: true })) ?? []).filter(isTenantId).sort();
    },
  };
}
