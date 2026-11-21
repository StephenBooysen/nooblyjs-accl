// Ingress (spec 8.4; tasks 8.4.1, 8.4.3, 8.4.5, 8.4.7, 8.4.8): what a region's ingress pool serves, kept in step with
// its workloads. An ingress pool is a host pool with `purpose: ingress` (pools.js): VMs with a static address each,
// running Caddy and the agent. sync(region) renders every web workload of the region as a site — its host names, its
// running instances as upstreams (a host's private address and the instance's published port) with active health
// checks — and sends the lot to each ingress VM (`ingress.sync`, which the agent turns into Caddy's JSON config). The
// runtime calls sync() whenever where a workload answers changes, and waits for it during a rolling deploy, so a new
// instance is in rotation before an old one leaves it.
//
// Host names: the workload's `domains` under the platform domain (the launcher passes the exact name) or, with none,
// `<name>-<tenant>.<platformDomain>`; served with the wildcard certificate. Other domains are custom: served once
// their DNS points at the region's ingress addresses (a CNAME to the platform name or A records), with a certificate
// Caddy asks for on demand after tlsAsk() says yes. Traffic: each ingress VM's per-host counters, summed per workload
// into hourly buckets (requests, bytes out, 5xx) for 8.5 and billing. Sleeping services answer with the wake hook.
import { HTTP_KINDS } from './names.js';

const DOMAINS = ['ingress', 'domains.yaml'];
const TRAFFIC = ['ingress', 'traffic.yaml'];
const LAST = ['ingress', 'counters.yaml'];
const STATE = (region) => ['ingress', `${region}.yaml`];
const KEEP_HOURS = 48;

/** A tenant id as a DNS label: lower case, dots and underscores as hyphens. */
export const tenantSlug = (tenantId) => String(tenantId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.servers     local servers (the ingress pool's VMs are servers of its site)
 * @param {object} o.hub
 * @param {object} o.runtime     the local runtime: list() of instances
 * @param {() => Promise<object[]>} o.ingressPools   the pools with purpose ingress
 * @param {(name: string) => Promise<object|null>} o.vm   a VM record (for an ingress VM's public address)
 * @param {(region?: string) => Promise<{ tenantId: string, w: object }[]>} o.workloads
 * @param {(region: string) => Promise<{ lookup: (host: string) => Promise<string[]> }>} o.dnsFor
 * @param {string|null} o.platformDomain    INFRA_PLATFORM_DOMAIN
 * @param {(region: string) => Promise<{ provider: string, project?: string, zone?: string } | null>} [o.wildcardFor]
 *   the DNS-01 settings for the platform domain's wildcard certificate in a region (its cloud's DNS), or null
 * @param {() => string|null} o.hooksBase  the URL ingress VMs reach this controller's hooks on (INFRA_PUBLIC_URL + mount)
 * @param {(type: string, payload: object) => Promise<void>} [o.emit]
 * @param {() => number} o.now
 * @param {object} o.log
 */
export function createIngress({ store, servers, hub, runtime, ingressPools, vm, workloads, dnsFor, platformDomain, wildcardFor = async () => null, hooksBase, emit = async () => {}, now, log }) {
  const iso = () => new Date(now()).toISOString();
  const chains = new Map(); // region → the sync under way
  let closed = false;

  /** A workload's host names: { platform: [...], custom: [...] }. */
  function hostsOf(tenantId, w) {
    if (!HTTP_KINDS.has(w.kind) || w.kind === 'private') return { platform: [], custom: [] };
    const under = (d) => platformDomain && (d === platformDomain || d.endsWith(`.${platformDomain}`));
    const domains = w.domains ?? [];
    const platform = domains.filter(under);
    if (!platform.length && platformDomain) platform.push(`${w.name}-${tenantSlug(tenantId)}.${platformDomain}`);
    return { platform, custom: domains.filter((d) => !under(d)) };
  }

  const poolsIn = async (region) => (await ingressPools()).filter((p) => p.region === region && p.status === 'active');

  /** The region's ingress VMs whose agent is online. */
  async function ingressServers(region) {
    const out = [];
    for (const p of await poolsIn(region)) {
      for (const s of await servers.servers({ site: `pool-${p.name}` })) if (hub.isOnline(s.id) && !s.draining) out.push(s);
    }
    return out;
  }

  /** The region's ingress addresses (what the platform domain's DNS and custom domains point at). */
  async function addresses(region) {
    const out = [];
    for (const p of await poolsIn(region)) {
      for (const s of await servers.servers({ site: `pool-${p.name}` })) {
        const v = s.vm ? await vm(s.vm) : null;
        if (v?.observed?.publicIp) out.push(v.observed.publicIp);
      }
    }
    return [...new Set(out)].sort();
  }

  const domainState = async () => (await store.readYaml(DOMAINS)) ?? { domains: {} };

  /** Every web workload of the region as a site. */
  async function sitesFor(region) {
    const instances = await runtime.list();
    const verified = (await domainState()).domains;
    const sites = [];
    for (const { tenantId, w } of await workloads(region)) {
      if (w.kind !== 'service' || w.status === 'deleting') continue;
      const { platform, custom } = hostsOf(tenantId, w);
      const hosts = [...platform, ...custom.filter((d) => verified[d]?.status === 'verified' && verified[d].tenantId === tenantId && verified[d].workload === w.name)];
      const upstreams = instances
        .filter((i) => i.labels?.['noobly-tenant'] === tenantId && i.labels?.['noobly-workload'] === w.name && i.status === 'running' && i.hostPort && i.url)
        .map((i) => `${new URL(i.url).hostname}:${i.hostPort}`);
      sites.push({ id: siteId(tenantId, w.name), hosts, upstreams, health: { path: w.healthCheck?.path ?? '/' }, sleeping: w.status === 'sleeping' });
    }
    return sites;
  }
  const siteId = (tenantId, name) => `${tenantSlug(tenantId).slice(0, 40)}-${name}`.slice(0, 100);

  /** Sends the region's sites to each of its ingress VMs (one sync at a time per region; the latest always wins). */
  function sync(region) {
    if (closed) return Promise.resolve({ synced: 0 });
    const run = async () => {
      if (closed) return { synced: 0 };
      const targets = await ingressServers(region);
      if (!targets.length) return { synced: 0 };
      const base = hooksBase();
      const wildcard = platformDomain ? await wildcardFor(region) : null;
      const args = {
        sites: await sitesFor(region),
        ...(wildcard ? { wildcard: { domain: platformDomain, ...wildcard } } : {}),
        ...(base ? { ask: `${base}/hooks/platform/tls-ask`, wake: `${base}/hooks/platform/wake` } : {}),
      };
      const failed = [];
      for (const s of targets) {
        try {
          await hub.command(s.id, 'ingress.sync', args, { timeoutMs: 60_000 });
        } catch (err) {
          failed.push(`${s.vm ?? s.hostname}: ${err.message}`);
        }
      }
      const state = { region, syncedAt: iso(), sites: args.sites.length, servers: targets.map((s) => s.vm ?? s.hostname), error: failed.length ? failed.join('; ') : null };
      await store.writeYaml(STATE(region), state);
      if (failed.length) log.warn(`ingress ${region}: ${state.error}`);
      return { synced: targets.length - failed.length, failed };
    };
    const next = (chains.get(region) ?? Promise.resolve()).catch(() => {}).then(run);
    chains.set(region, next);
    return next;
  }

  /** Whether the region has an ingress pool (rolling deploys wait for it). */
  const has = async (region) => (await poolsIn(region)).length > 0;

  // ---------------------------------------------------------------- custom domains (8.4.5)

  /** The DNS job: a custom domain is verified when it resolves to one of its region's ingress addresses. */
  async function checkDomains() {
    let changed = 0;
    const regions = new Set();
    await store.withLock(DOMAINS, async () => {
      const st = await domainState();
      const seen = new Set();
      for (const { tenantId, w } of await workloads()) {
        for (const d of hostsOf(tenantId, w).custom) {
          seen.add(d);
          const want = await addresses(w.region);
          const got = want.length ? await (await dnsFor(w.region)).lookup(d).catch(() => []) : [];
          const ok = got.some((a) => want.includes(a));
          const prev = st.domains[d];
          const status = ok ? 'verified' : 'pending';
          if (prev?.status !== status || prev?.tenantId !== tenantId || prev?.workload !== w.name) {
            changed += 1;
            regions.add(w.region);
            if (ok) await emit('infrastructure.workload.domain_verified', { tenantId, workload: w.name, domain: d });
          }
          st.domains[d] = { tenantId, workload: w.name, region: w.region, status, checkedAt: iso(), ...(ok ? { verifiedAt: prev?.verifiedAt ?? iso() } : { expect: want }) };
        }
      }
      for (const d of Object.keys(st.domains)) {
        if (!seen.has(d)) {
          regions.add(st.domains[d].region);
          delete st.domains[d];
          changed += 1;
        }
      }
      await store.writeYaml(DOMAINS, st);
    });
    for (const r of regions) if (r) await sync(r);
    return { changed };
  }

  /** On-demand TLS (Design): yes only for a verified custom domain of a live workload, or a platform name. */
  async function tlsAsk(domain) {
    const d = String(domain ?? '').toLowerCase();
    if (!d) return false;
    const found = (await domainState()).domains[d];
    for (const { tenantId, w } of await workloads()) {
      if (!['live', 'sleeping'].includes(w.status)) continue;
      const { platform, custom } = hostsOf(tenantId, w);
      if (platform.includes(d)) return true;
      if (custom.includes(d) && found?.status === 'verified' && found.tenantId === tenantId) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- traffic (8.4.7)

  /** The counters job: each ingress VM's per-host totals, as deltas, into hourly buckets per workload. */
  async function collect() {
    const regions = new Set((await ingressPools()).filter((p) => p.status === 'active').map((p) => p.region));
    const byHost = new Map();
    for (const region of regions) {
      for (const { tenantId, w } of await workloads(region)) {
        const { platform, custom } = hostsOf(tenantId, w);
        for (const h of [...platform, ...custom]) byHost.set(h, `${tenantId}/${w.name}`);
      }
    }
    const hour = iso().slice(0, 13);
    let counted = 0;
    await store.withLock(TRAFFIC, async () => {
      const last = (await store.readYaml(LAST)) ?? {};
      const traffic = (await store.readYaml(TRAFFIC)) ?? { workloads: {} };
      for (const region of regions) {
        for (const s of await ingressServers(region)) {
          let hosts;
          try {
            hosts = (await hub.command(s.id, 'ingress.counters', {}, { timeoutMs: 15_000 })).hosts ?? {};
          } catch (err) {
            log.warn(`ingress counters from ${s.vm ?? s.id}: ${err.message}`);
            continue;
          }
          const before = last[s.id] ?? {};
          for (const [host, now_] of Object.entries(hosts)) {
            const key = byHost.get(host);
            const prev = before[host] ?? { requests: 0, bytesOut: 0, errors: 0 };
            // Caddy restarted (its totals went down): what it says now is all new.
            const reset = now_.requests < prev.requests;
            const d = reset ? now_ : { requests: now_.requests - prev.requests, bytesOut: now_.bytesOut - prev.bytesOut, errors: now_.errors - prev.errors };
            if (key && d.requests > 0) {
              const row = ((traffic.workloads[key] ??= { hours: {} }).hours[hour] ??= { requests: 0, bytesOut: 0, errors: 0 });
              row.requests += d.requests;
              row.bytesOut += d.bytesOut;
              row.errors += d.errors;
              traffic.workloads[key].lastRequestAt = iso();
              counted += d.requests;
            }
          }
          last[s.id] = hosts;
        }
      }
      const oldest = new Date(now() - KEEP_HOURS * 3600_000).toISOString().slice(0, 13);
      for (const v of Object.values(traffic.workloads)) for (const h of Object.keys(v.hours)) if (h < oldest) delete v.hours[h];
      await store.writeYaml(LAST, last);
      await store.writeYaml(TRAFFIC, traffic);
    });
    return { counted };
  }

  /** A workload's traffic over the last `hours`: { requests, bytesOut, errors, lastRequestAt }. */
  async function traffic(tenantId, name, { hours = 24 } = {}) {
    const row = ((await store.readYaml(TRAFFIC)) ?? { workloads: {} }).workloads[`${tenantId}/${name}`];
    const from = new Date(now() - hours * 3600_000).toISOString().slice(0, 13);
    const out = { requests: 0, bytesOut: 0, errors: 0, lastRequestAt: row?.lastRequestAt ?? null, hours };
    for (const [h, v] of Object.entries(row?.hours ?? {})) {
      if (h < from) continue;
      out.requests += v.requests;
      out.bytesOut += v.bytesOut;
      out.errors += v.errors;
    }
    return out;
  }

  /** For the Platform screen: per region with an ingress pool, its addresses, last sync and custom domains. */
  async function view() {
    const regions = [...new Set((await ingressPools()).map((p) => p.region))].sort();
    const domains = (await domainState()).domains;
    return Promise.all(regions.map(async (region) => ({
      region,
      addresses: await addresses(region),
      online: (await ingressServers(region)).length,
      state: await store.readYaml(STATE(region)),
      platformDomain,
      wildcard: Boolean(platformDomain && await wildcardFor(region)),
      domains: Object.entries(domains).filter(([, d]) => d.region === region).map(([host, d]) => ({ host, ...d })),
    })));
  }

  /** Syncs the region a workload runs in (the runtime calls this when where it answers changes). */
  async function syncWorkload(tenantId, name) {
    const found = (await workloads()).find((x) => x.tenantId === tenantId && x.w.name === name);
    if (found && await has(found.w.region)) await sync(found.w.region);
  }

  /** The workload a host name belongs to (the wake hook), or null. */
  async function find(hostName) {
    const h = String(hostName ?? '').toLowerCase();
    for (const { tenantId, w } of await workloads()) {
      const { platform, custom } = hostsOf(tenantId, w);
      if (platform.includes(h) || custom.includes(h)) return { tenantId, w };
    }
    return null;
  }

  /** Waits for the syncs under way; none start after. */
  async function close() {
    closed = true;
    await Promise.allSettled([...chains.values()]);
  }

  return { close, hostsOf, sitesFor, sync, syncWorkload, has, addresses, checkDomains, tlsAsk, collect, traffic, view, find, domainState };
}
