// Usage events (spec §4 pay_usage, §6): kept per calendar month (UTC) in containers `<prefix>_usage_<yyyymm>`, written a
// batch at a time (one document per recordUsage call, so an hourly hand-off of many events is one write). Idempotent by
// key within the month of the event's time.
import { createRepo, createMutex } from '../shared/store.js';
import { newId } from '../shared/ids.js';

const monthTag = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** The month tags from `fromMs` to `toMs` (exclusive). */
function tagsBetween(fromMs, toMs) {
  const out = [];
  const d = new Date(fromMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (Date.UTC(y, m, 1) < toMs) {
    out.push(`${y}${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

export function createUsageStore({ dataService, prefix, clock }) {
  const shards = new Map();
  const lock = createMutex();

  function shard(tag) {
    if (!shards.has(tag)) {
      shards.set(tag, (async () => {
        const repo = createRepo(dataService, `${prefix}_usage_${tag}`, clock);
        await repo.init();
        const keys = new Set();
        const byAccount = new Map();
        const index = (ev) => {
          keys.add(ev.idempotencyKey);
          if (!byAccount.has(ev.accountId)) byAccount.set(ev.accountId, []);
          byAccount.get(ev.accountId).push(ev);
        };
        for (const batch of repo.list()) for (const ev of batch.events) index(ev);
        return { repo, keys, byAccount, index };
      })());
    }
    return shards.get(tag);
  }

  return {
    /**
     * Records checked events ({ accountId, meter, quantity, at, idempotencyKey }); a key seen before is skipped.
     * @returns {Promise<{ recorded: number, duplicates: number }>}
     */
    async record(list) {
      const groups = new Map();
      for (const ev of list) {
        const tag = monthTag(Date.parse(ev.at));
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag).push(ev);
      }
      let recorded = 0;
      let duplicates = 0;
      for (const [tag, events] of groups) {
        await lock(tag, async () => {
          const s = await shard(tag);
          const fresh = [];
          const seen = new Set();
          for (const ev of events) {
            if (s.keys.has(ev.idempotencyKey) || seen.has(ev.idempotencyKey)) { duplicates += 1; continue; }
            seen.add(ev.idempotencyKey);
            fresh.push(ev);
          }
          if (!fresh.length) return;
          await s.repo.insert({ id: newId('ub'), events: fresh });
          for (const ev of fresh) s.index(ev);
          recorded += fresh.length;
        });
      }
      return { recorded, duplicates };
    },
    /** An account's events with fromMs ≤ at < toMs (optionally one meter). */
    async query(accountId, fromMs, toMs, meter = null) {
      const out = [];
      for (const tag of tagsBetween(fromMs, toMs)) {
        const s = await shard(tag);
        for (const ev of s.byAccount.get(accountId) ?? []) {
          const at = Date.parse(ev.at);
          if (at >= fromMs && at < toMs && (!meter || ev.meter === meter)) out.push(ev);
        }
      }
      return out;
    },
  };
}
