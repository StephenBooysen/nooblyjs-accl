// Records on nooblyjs-core's dataService (spec §4): one container per record type, prefixed (`pay_accounts`). Every
// record has an id, a version (optimistic concurrency, ETag W/"n"), createdAt and updatedAt. Reads come from an
// in-memory copy loaded at start (one process owns the containers, like the customers accelerator's repositories);
// every write goes through to the dataService before it is visible.
import { conflict, notFound, preconditionFailed } from './errors.js';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Runs one function at a time per key. */
export function createMutex() {
  const tails = new Map();
  return async function run(key, fn) {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

async function ensureContainer(dataService, name) {
  try {
    await dataService.createContainer(name);
  } catch (err) {
    if (!/exist/i.test(err.message)) throw err;
  }
}

/**
 * @param {object} dataService   core dataService (createContainer, addWithKey, update, remove, listAll)
 * @param {string} container
 * @param {{ now: () => number }} clock
 * @param {{ unique?: Record<string, (doc) => string|null> }} [o]   unique keys, checked on insert and update
 */
export function createRepo(dataService, container, clock, { unique = {} } = {}) {
  const docs = new Map();
  const indexes = Object.fromEntries(Object.keys(unique).map((k) => [k, new Map()]));
  const lock = createMutex();
  const iso = () => new Date(clock.now()).toISOString();

  function index(doc, add = true) {
    for (const [name, keyOf] of Object.entries(unique)) {
      const key = keyOf(doc);
      if (key === null || key === undefined) continue;
      if (add) indexes[name].set(key, doc.id);
      else if (indexes[name].get(key) === doc.id) indexes[name].delete(key);
    }
  }
  function clash(doc) {
    for (const [name, keyOf] of Object.entries(unique)) {
      const key = keyOf(doc);
      if (key === null || key === undefined) continue;
      const holder = indexes[name].get(key);
      if (holder && holder !== doc.id) return name;
    }
    return null;
  }

  return {
    container,
    async init() {
      await ensureContainer(dataService, container);
      for (const doc of await dataService.listAll(container)) {
        if (doc?.id) {
          docs.set(doc.id, doc);
          index(doc);
        }
      }
    },
    get(id) {
      return clone(docs.get(id) ?? null);
    },
    must(id, what) {
      const doc = docs.get(id);
      if (!doc) throw notFound(what);
      return clone(doc);
    },
    by(indexName, key) {
      const id = indexes[indexName]?.get(key);
      return id ? clone(docs.get(id)) : null;
    },
    list(test = () => true) {
      const out = [];
      for (const doc of docs.values()) if (test(doc)) out.push(clone(doc));
      return out;
    },
    count(test = () => true) {
      let n = 0;
      for (const doc of docs.values()) if (test(doc)) n += 1;
      return n;
    },
    /** Inserts a new record (id required). Unique keys clash → 409. */
    async insert(doc) {
      return lock(`doc:${doc.id}`, async () => {
        if (docs.has(doc.id)) throw conflict(`${doc.id} exists.`);
        const at = iso();
        const record = { ...doc, version: 1, createdAt: doc.createdAt ?? at, updatedAt: at };
        const name = clash(record);
        if (name) throw conflict(`Another record has the same ${name}.`, [{ path: name, message: 'Already used.' }]);
        await dataService.addWithKey(container, record.id, clone(record));
        docs.set(record.id, record);
        index(record);
        return clone(record);
      });
    },
    /**
     * Changes a record under its lock: `fn(copy)` returns the next record, or null/undefined to leave it.
     * @param {{ expectedVersion?: number }} [o]
     */
    async update(id, fn, { expectedVersion, what } = {}) {
      return lock(`doc:${id}`, async () => {
        const current = docs.get(id);
        if (!current) throw notFound(what);
        if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== current.version) throw preconditionFailed();
        const next = await fn(clone(current));
        if (!next) return clone(current);
        const record = { ...next, id, version: current.version + 1, createdAt: current.createdAt, updatedAt: iso() };
        const name = clash(record);
        if (name) throw conflict(`Another record has the same ${name}.`, [{ path: name, message: 'Already used.' }]);
        await dataService.update(container, id, clone(record));
        index(current, false);
        docs.set(id, record);
        index(record);
        return clone(record);
      });
    },
    /** Only for records that are not money (idempotency entries past their expiry). */
    async remove(id) {
      return lock(`doc:${id}`, async () => {
        const current = docs.get(id);
        if (!current) return false;
        await dataService.remove(container, id);
        index(current, false);
        docs.delete(id);
        return true;
      });
    },
  };
}

/** Lists the customers accelerator's way: filter[...] equality, sort (-field for descending), limit, offset. */
export function page(items, { limit = 50, offset = 0, sort = '-createdAt' } = {}) {
  const desc = sort.startsWith('-');
  const field = sort.replace(/^-/, '');
  const sorted = [...items].sort((a, b) => {
    const x = a[field] ?? '';
    const y = b[field] ?? '';
    return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
  });
  const l = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const o = Math.max(Number(offset) || 0, 0);
  return { items: sorted.slice(o, o + l), total: items.length, limit: l, offset: o };
}
