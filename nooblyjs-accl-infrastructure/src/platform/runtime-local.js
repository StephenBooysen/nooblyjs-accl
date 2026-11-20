// The local runtime (spec 8.9 R6–R11): the same methods as runtime-mock.js, but instances are containers on the
// enrolled servers of a local site, driven through each server's agent. The platform's operations call it for
// workloads whose region is a local site.
//
// v1 choices, written down: each online server of the site builds the image itself (no registry yet, R8); a rollout
// starts the new instances, checks their health, and only then removes the old ones, so a failed deploy leaves the
// old ones serving; instance records live in local/instances.yaml; runtime logs are followed from the moment an
// instance starts and handed to `onLog`.
//
// Lost servers (R7, task 8.9.7): when a server's agent drops, its instances are `unknown` and get no traffic. If it
// comes back they are checked with `container.list` and serve again. Once it has been offline for `replaceAfterMs`
// (5 minutes), replaceLost() places each of its instances again on another online server with room, building the
// image there from the build recorded in local/images.yaml (no registry yet), and only drops the old record once the
// new instance answers. Without room they stay `unknown` and the reason is reported once. Containers the controller no
// longer knows about are removed when their server comes back.
import crypto from 'node:crypto';
import { CloudError } from '../providers/errors.js';
import { hasLabels } from '../providers/contract.js';
import { HOST_PORTS } from '../../agent/protocol.js';

const FILE = ['local', 'instances.yaml'];
const IMAGES = ['local', 'images.yaml'];
export const REPLACE_AFTER_MS = 5 * 60_000;
const short = (s, n = 12) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
const rand = (n = 6) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const MAX_HEALTH_S = 120;

/** A source's clone URL: a full https:// URL, or a GitHub "owner/name". */
export function cloneUrl(repo) {
  if (typeof repo !== 'string' || !repo) return null;
  if (/^https:\/\//.test(repo) || /^file:\/\//.test(repo)) return repo;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return `https://github.com/${repo}.git`;
  return null;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {ReturnType<import('./local.js').createLocalServers>} o.servers
 * @param {ReturnType<import('../services/agents.js').createAgentHub>} o.hub
 * @param {(tenantId: string, refs: string[]) => Promise<Record<string, string>>} [o.resolveSecrets]
 * @param {(tenantId: string, workload: string, lines: object[]) => void} [o.onLog]
 * @param {(change: object) => void} [o.onInstances]  an instance went unknown, came back, moved or could not move
 * @param {(tenantId: string, workload: string, sample: object) => void} [o.onMetrics]  one instance's 10 s sample (8.5 R1)
 * @param {(tenantId: string, workload: string) => void} [o.onEndpoints]  where a workload answers changed (a launcher's proxy re-reads it)
 * @param {number} [o.drainMs]  after switching to new instances, how long the old ones keep running for requests in flight
 * @param {() => number} o.now
 * @param {{ warn: Function, info: Function }} o.log
 */
export function createLocalRuntime({ store, servers, hub, resolveSecrets = async () => ({}), onLog = () => {}, onInstances = () => {}, onMetrics = () => {}, onEndpoints = () => {}, drainMs = 2000, statsEveryS = 10, now, log }) {
  const iso = () => new Date(now()).toISOString();
  /** Site ids this runtime answers for (kept in step with servers.sites()). */
  const siteIds = new Set();
  /** stream id → handler(frame) */
  const streams = new Map();

  const read = async () => (await store.readYaml(FILE)) ?? { instances: [] };
  const change = (fn) => store.withLock(FILE, async () => {
    const state = await read();
    const result = await fn(state);
    await store.writeYaml(FILE, state);
    return result;
  });

  const endpointsChanged = (tenantId, workload) => {
    try { onEndpoints(tenantId, workload); } catch (err) { log.warn(`an endpoints listener failed: ${err.message}`); }
  };
  const report = (change) => {
    try { onInstances(change); } catch (err) { log.warn(`an instances listener failed: ${err.message}`); }
    endpointsChanged(change.tenantId, change.workload);
  };
  const tenantOf = (i) => ({ tenantId: i.labels['noobly-tenant'], workload: i.labels['noobly-workload'] });
  /** What each image was built from, so another server can build it again (no registry in v1). */
  const images = {
    read: async () => (await store.readYaml(IMAGES)) ?? { images: {} },
    async record(tag, spec, serverId) {
      await store.withLock(IMAGES, async () => {
        const st = await images.read();
        const prev = st.images[tag];
        st.images[tag] = { ...spec, builtOn: [...new Set([...(prev?.builtOn ?? []), serverId])], at: iso() };
        // Keep the latest few per workload: old tags are only for instances still running them.
        const keep = new Set((await read()).instances.map((i) => i.image));
        const byWorkload = new Map();
        for (const [t, v] of Object.entries(st.images)) {
          const k = `${v.labels?.['noobly-tenant']}/${v.labels?.['noobly-workload']}`;
          byWorkload.set(k, [...(byWorkload.get(k) ?? []), [t, v]]);
        }
        for (const list of byWorkload.values()) {
          list.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
          for (const [t] of list.slice(3)) if (!keep.has(t) && t !== tag) delete st.images[t];
        }
        await store.writeYaml(IMAGES, st);
      });
    },
    async forget(labels) {
      await store.withLock(IMAGES, async () => {
        const st = await images.read();
        for (const [t, v] of Object.entries(st.images)) if (v.labels?.['noobly-tenant'] === labels['noobly-tenant'] && v.labels?.['noobly-workload'] === labels['noobly-workload']) delete st.images[t];
        await store.writeYaml(IMAGES, st);
      });
    },
  };

  const ofWorkload = (labels) => (c) => c.labels?.['noobly-tenant'] === labels['noobly-tenant'] && c.labels?.['noobly-workload'] === labels['noobly-workload'];
  const tenantHash = (labels) => short(labels['noobly-tenant']);
  const agentLabels = (labels) => ({ ...labels });

  /** An agent command, with its failure as a CloudError the operations engine understands. */
  async function send(server, name, args, o) {
    try {
      return await hub.command(server, name, args, o);
    } catch (err) {
      const code = err.code === 'offline' || err.code === 'timeout' ? 'unavailable' : err.code === 'invalid' ? 'invalid' : 'invalid';
      throw new CloudError(code, err.message);
    }
  }

  /** Runs `fn(frame)` for every log/stats/stream-end frame of a stream until it ends. */
  function onStream(id, fn) {
    streams.set(id, fn);
    return () => streams.delete(id);
  }

  async function onlineServers(site) {
    return (await servers.servers({ site })).filter((s) => hub.isOnline(s.id));
  }

  async function siteOf(region) {
    const site = await servers.site(region);
    if (!site) throw new CloudError('invalid', `No local site ${region}.`);
    return site;
  }

  /** Where an instance answers: the site's bind address, or the server's first LAN address when it binds all. */
  const hostOf = (site, server) => (site.bind === '0.0.0.0' ? server.facts?.addresses?.[0] ?? '127.0.0.1' : site.bind);

  /**
   * Follows an instance's output into onLog. Resuming (8.5 R5) asks Docker for lines from `since`, the timestamp of
   * the last line delivered; lines before it, and the last line itself, were delivered already and are dropped.
   */
  async function follow(inst, since = null) {
    const stream = `l-${inst.name.slice(-20)}-${rand(4)}`.replace(/[^a-z0-9-]/g, '');
    const tenantId = inst.labels['noobly-tenant'];
    const workload = inst.labels['noobly-workload'];
    const seen = since ? new Set(inst.logTail ?? []) : null;
    onStream(stream, (frame) => {
      if (frame.type === 'log') {
        const lines = seen
          ? frame.lines.filter((l) => !(l.at < since || (l.at === since && seen.has(`${l.out}\u0000${l.line}`))))
          : frame.lines;
        if (!lines.length) return;
        onLog(tenantId, workload, lines.map((l) => ({ ...l, instance: inst.name })));
        const last = lines.at(-1).at;
        // The lines carrying the last timestamp, so a resume skips exactly those.
        const tail = lines.filter((l) => l.at === last).map((l) => `${l.out}\u0000${l.line}`).slice(-20);
        change((s) => {
          const i = s.instances.find((x) => x.name === inst.name);
          if (!i) return;
          i.logTail = i.logAt === last ? [...new Set([...(i.logTail ?? []), ...tail])].slice(-20) : tail;
          i.logAt = last;
        }).catch(() => {});
      }
      if (frame.type === 'stream-end') streams.delete(stream);
    });
    try {
      await hub.command(inst.server, 'logs.follow', { name: inst.name, stream, ...(since ? { since } : {}) });
    } catch (err) {
      streams.delete(stream);
      log.warn(`could not follow ${inst.name}: ${err.message}`);
    }
  }

  async function envFor(tenantId, run) {
    const env = run?.env ?? [];
    const refs = env.filter((e) => e.secretRef).map((e) => e.secretRef);
    const values = refs.length ? await resolveSecrets(tenantId, refs) : {};
    const out = env.map((e) => ({ key: e.key, value: e.secretRef ? values[e.secretRef] ?? '' : String(e.value ?? '') }));
    // PORT is the platform's, as on Render: the app listens where it is told.
    if (run?.port && !out.some((e) => e.key === 'PORT')) out.push({ key: 'PORT', value: String(run.port) });
    return out;
  }

  async function startInstance({ site, server, labels, image, plan, run, tenantId, network, taken }) {
    const range = { min: Math.max(HOST_PORTS.min, site.ports?.min ?? HOST_PORTS.min), max: Math.min(HOST_PORTS.max, site.ports?.max ?? HOST_PORTS.max) };
    const nextPort = () => {
      for (let p = range.min; p <= range.max; p += 1) if (!taken.has(`${server.id}:${p}`)) { taken.add(`${server.id}:${p}`); return p; }
      throw new CloudError('quota', `${server.hostname} has no free port.`);
    };
    const name = `noobly-${tenantHash(labels).slice(0, 8)}-${labels['noobly-workload']}-${rand(6)}`.slice(0, 108);
    const instLabels = { ...agentLabels(labels), 'noobly-instance': name.slice(-6) };
    const bind = site.bind === '0.0.0.0' ? '0.0.0.0' : site.bind;
    const env = await envFor(tenantId, run);
    let hostPort = null;
    // A port something else on the server holds (not one of ours) is skipped: try the next one, a few times.
    for (let attempt = 0; ; attempt += 1) {
      hostPort = run?.port ? nextPort() : null;
      try {
        await send(server.id, 'container.run', {
          name, image, labels: instLabels, network, cpu: plan.cpu, memoryMb: plan.memoryMb,
          ...(hostPort ? { port: run.port, hostPort, bind } : {}),
          env,
        });
        break;
      } catch (err) {
        if (!hostPort || attempt >= 20 || !/port is already allocated|address already in use/i.test(err.message)) throw err;
        await hub.command(server.id, 'container.remove', { name }).catch(() => {});
      }
    }
    return {
      id: name, name, server: server.id, region: site.id, labels: instLabels, image, cpu: plan.cpu, memoryMb: plan.memoryMb,
      port: run?.port ?? null, hostPort, url: hostPort ? `http://${hostOf(site, server)}:${hostPort}` : null, status: 'running', startedAt: iso(),
    };
  }

  /** What an instance record keeps of the run spec to start it again elsewhere: secret refs, never values. */
  const runOf = (run) => (run ? { ...(run.port ? { port: run.port } : {}), env: (run.env ?? []).map((e) => (e.secretRef ? { key: e.key, secretRef: e.secretRef } : { key: e.key, value: String(e.value ?? '') })) } : null);

  /** Free CPU and memory per online server, counting the running/starting/unknown instances not in `except`. */
  function freeOf(state, online, except = []) {
    const used = new Map();
    for (const i of state.instances.filter((x) => ['running', 'starting', 'unknown'].includes(x.status) && !except.includes(x))) {
      const u = used.get(i.server) ?? { cpu: 0, memoryMb: 0 };
      used.set(i.server, { cpu: u.cpu + i.cpu, memoryMb: u.memoryMb + i.memoryMb });
    }
    return {
      used,
      /** The online server with the most free memory that fits `plan`, or null; counts it as used. */
      take(plan) {
        const free = online.map((s) => {
          const u = used.get(s.id) ?? { cpu: 0, memoryMb: 0 };
          const alloc = s.allocatable ?? { cpu: s.facts?.cpus ?? 0, memoryMb: s.facts?.memoryMb ?? 0 };
          return { s, cpu: alloc.cpu - u.cpu, memoryMb: alloc.memoryMb - u.memoryMb };
        }).filter((f) => f.memoryMb >= plan.memoryMb && f.cpu >= plan.cpu * 0.25).sort((a, b) => b.memoryMb - a.memoryMb);
        if (!free.length) return null;
        const s = free[0].s;
        const u = used.get(s.id) ?? { cpu: 0, memoryMb: 0 };
        used.set(s.id, { cpu: u.cpu + plan.cpu, memoryMb: u.memoryMb + plan.memoryMb });
        return s;
      },
    };
  }

  /** Builds `image` on `server` from its recorded build, unless that server has it already. */
  async function ensureImage(server, image, log_) {
    const rec = (await images.read()).images[image];
    if (!rec) throw new CloudError('invalid', `There is no record of how ${image} was built; deploy the service again.`);
    if (rec.builtOn?.includes(server.id)) return;
    const stream = `b-${rand(12)}`;
    let chain = Promise.resolve();
    onStream(stream, (frame) => {
      if (frame.type === 'log') for (const l of frame.lines) if (l.line.trim()) chain = chain.then(() => log_(l.line)).catch(() => {});
    });
    try {
      await send(server.id, 'image.build', { ...rec.args, tag: image, stream, mask: [] }, { timeoutMs: 30 * 60_000 });
    } finally {
      await chain;
      streams.delete(stream);
    }
    await images.record(image, rec, server.id);
  }

  /** Waits for one instance to answer its health check (up to MAX_HEALTH_S, in the agent's 60 s slices). */
  async function waitHealthy(inst, path, budgetS, log_) {
    const end = Date.now() + budgetS * 1000;
    while (Date.now() < end) {
      const slice = Math.max(1, Math.min(60, Math.ceil((end - Date.now()) / 1000)));
      const r = await send(inst.server, 'health.check', { name: inst.name, port: inst.port, path, timeoutS: slice }, { timeoutMs: (slice + 10) * 1000 });
      if (r.ok) return r;
      if (r.exited) {
        if (r.tail) for (const line of r.tail.trim().split('\n').slice(-10)) await log_(`  ${line}`);
        throw new CloudError('invalid', `${r.message} The last lines it printed are above.`);
      }
    }
    throw new CloudError('invalid', `The app did not answer on ${path} at port ${inst.port} within ${budgetS} seconds. Does it listen on the PORT variable?`);
  }

  let replacing = null;

  /** serverId → { at, cpu, memoryMb, rxBytes, txBytes, instances } from its latest stats frame (metrics.vm). */
  const serverStats = new Map();
  const num = (v, max = 1e15) => (Number.isFinite(Number(v)) ? Math.min(Math.max(0, Number(v)), max) : 0);

  /** One stats frame from a server: a sample per known instance (8.5 R1), with the plan's limits alongside. */
  async function onStats(serverId, frame) {
    const samples = Array.isArray(frame.samples) ? frame.samples.slice(0, 500) : [];
    const byName = new Map((await read()).instances.filter((i) => i.server === serverId).map((i) => [i.name, i]));
    const total = { at: frame.at, cpu: 0, memoryMb: 0, rxBytes: 0, txBytes: 0, instances: 0 };
    for (const raw of samples) {
      const inst = byName.get(String(raw?.name ?? ''));
      if (!inst) continue;
      const sample = {
        instance: inst.name, server: serverId, at: typeof frame.at === 'string' ? frame.at : iso(),
        cpu: { value: num(raw.cpu, 1024), unit: 'vCPU', limit: inst.cpu },
        memory: { value: num(raw.memoryMb, 1 << 22), unit: 'MB', limit: inst.memoryMb },
        netIn: { value: num(raw.rxBytes), unit: 'B', limit: null },
        netOut: { value: num(raw.txBytes), unit: 'B', limit: null },
      };
      total.cpu += sample.cpu.value;
      total.memoryMb += sample.memory.value;
      total.rxBytes += sample.netIn.value;
      total.txBytes += sample.netOut.value;
      total.instances += 1;
      const { tenantId, workload } = tenantOf(inst);
      try { onMetrics(tenantId, workload, sample); } catch (err) { log.warn(`a metrics listener failed: ${err.message}`); }
    }
    total.cpu = Math.round(total.cpu * 1000) / 1000;
    total.memoryMb = Math.round(total.memoryMb * 10) / 10;
    serverStats.set(serverId, total);
  }

  /** Starts a server's stats stream (every statsEveryS seconds) for this install's containers. */
  async function watchStats(serverId, install) {
    if (!install) return;
    const stream = `s-${serverId.slice(4, 16)}-${rand(4)}`;
    onStream(stream, (frame) => {
      if (frame.type === 'stats') onStats(serverId, frame).catch((err) => log.warn(`stats from ${serverId}: ${err.message}`));
      if (frame.type === 'stream-end') streams.delete(stream);
    });
    try {
      await hub.command(serverId, 'stats.watch', { labels: { 'noobly-install': install }, intervalS: Math.max(5, Math.min(60, statsEveryS)), stream });
    } catch (err) {
      streams.delete(stream);
      log.warn(`could not watch the stats of ${serverId}: ${err.message}`);
    }
  }

  /** Starts a copy of a lost instance on another online server, waits for it, then drops the lost one's record. */
  async function moveInstance(inst) {
    const site = await siteOf(inst.region);
    const online = (await onlineServers(site.id)).filter((s) => inst.gone || s.id !== inst.server);
    if (!online.length) throw new CloudError('unavailable', `No other server of ${site.name} is online.`);
    const state = await read();
    const plan = { cpu: inst.cpu, memoryMb: inst.memoryMb };
    const server = freeOf(state, online, [inst]).take(plan);
    if (!server) throw new CloudError('quota', `Site ${site.name} is full: there is no room for ${plan.cpu} CPU and ${plan.memoryMb} MB elsewhere.`);
    const { tenantId, workload } = tenantOf(inst);
    const say = async (line) => onLog(tenantId, workload, [{ at: iso(), out: 'stdout', line: `[noobly] ${line}`, instance: inst.name }]);
    await say(inst.gone
      ? `${inst.name} was gone when ${inst.server} came back; starting it again on ${server.hostname}`
      : `${inst.name} has been unreachable since ${inst.unknownSince}; starting it again on ${server.hostname}`);
    await ensureImage(server, inst.image, say);
    const labels = Object.fromEntries(Object.entries(inst.labels).filter(([k]) => k !== 'noobly-instance'));
    const network = `noobly-t-${tenantHash(labels)}`;
    await send(server.id, 'network.ensure', { name: network, labels: { ...labels, 'noobly-workload': 'network' } });
    const taken = new Set(state.instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
    const run = inst.run ?? (inst.port ? { port: inst.port } : null);
    const fresh = { ...await startInstance({ site, server, labels, image: inst.image, plan, run, tenantId, network, taken }), run: inst.run ?? runOf(run), healthPath: inst.healthPath ?? '/' };
    await change((st) => { st.instances.push({ ...fresh, status: 'starting', replaces: inst.name }); });
    try {
      if (fresh.port) await waitHealthy(fresh, fresh.healthPath, MAX_HEALTH_S, say);
    } catch (err) {
      await hub.command(server.id, 'container.remove', { name: fresh.name }).catch(() => {});
      await change((st) => { st.instances = st.instances.filter((i) => i.name !== fresh.name); });
      throw err;
    }
    // The copy answers: it serves, and the lost record goes (its container is removed if its server comes back).
    const stillLost = await change((st) => {
      const old = st.instances.find((i) => i.name === inst.name);
      const lostStill = old?.status === 'unknown';
      for (const i of st.instances) if (i.name === fresh.name) { i.status = 'running'; delete i.replaces; }
      if (lostStill) st.instances = st.instances.filter((i) => i.name !== inst.name);
      return lostStill;
    });
    if (!stillLost) {
      // Its server came back while we were starting the copy: keep the original, drop the copy.
      await hub.command(server.id, 'container.remove', { name: fresh.name }).catch(() => {});
      await change((st) => { st.instances = st.instances.filter((i) => i.name !== fresh.name); });
      throw new CloudError('unavailable', `${inst.server} came back while ${inst.name} was being moved; it stays where it was.`);
    }
    await follow(fresh);
    await say(`Moved to ${server.hostname} as ${fresh.name}`);
    report({ ...tenantOf(inst), change: 'moved', instance: inst.name, server: inst.server, to: server.id, name: fresh.name });
    return fresh;
  }

  const api = {
    name: 'local',
    /** True when `region` is a local site. */
    handles: (region) => siteIds.has(region),
    addSite: (id) => siteIds.add(id),
    sites: () => [...siteIds],

    /** For the hub: a log/stats/stream-end frame from a server. */
    onStream(server, frame) {
      streams.get(frame.stream)?.(frame);
    },

    /** A server's agent dropped: its instances get no traffic until it comes back or they move (R7). */
    async serverOffline(serverId) {
      serverStats.delete(serverId); // a gap in the samples, not stale numbers (8.5 R5)
      const lost = await change((st) => {
        const mine = st.instances.filter((i) => i.server === serverId && (i.status === 'running' || i.status === 'starting'));
        for (const i of mine) Object.assign(i, { status: 'unknown', unknownSince: iso() });
        return mine.map((i) => ({ ...i }));
      });
      for (const i of lost) report({ ...tenantOf(i), change: 'unknown', instance: i.name, server: serverId });
      return lost.length;
    },

    /**
     * A server came back: its instances that are still running serve again, and their logs are followed from where
     * they stopped (8.5 R5); containers the controller no longer knows about (moved while it was away, or removed)
     * are removed.
     */
    async serverOnline(serverId) {
      const state = await read();
      const known = state.instances.filter((i) => i.server === serverId);
      const install = hub.session(serverId)?.install ?? known[0]?.labels?.['noobly-install'] ?? null;
      await watchStats(serverId, install);
      let present = null;
      if (install) {
        try {
          present = (await hub.command(serverId, 'container.list', { labels: { 'noobly-install': install } })).containers ?? [];
        } catch (err) {
          log.warn(`could not list the containers on ${serverId}: ${err.message}`);
        }
      }
      const running = present ? new Set(present.filter((c) => c.state === 'running').map((c) => c.name)) : null;
      const back = await change((st) => {
        const out = [];
        for (const i of st.instances.filter((x) => x.server === serverId && x.status === 'unknown')) {
          if (running && !running.has(i.name)) { i.gone = true; continue; } // gone while away: it moves at once
          i.status = 'running';
          delete i.unknownSince;
          delete i.replaceProblem;
          delete i.gone;
          out.push({ ...i });
        }
        return out;
      });
      for (const i of back) report({ ...tenantOf(i), change: 'back', instance: i.name, server: serverId });
      const now_ = (await read()).instances.filter((i) => i.server === serverId && i.status === 'running');
      for (const inst of now_) await follow(inst, inst.logAt ?? null);
      // Leftovers: ours by label, not in the records for this server (job containers remove themselves).
      if (present) {
        const mine = new Set((await read()).instances.filter((i) => i.server === serverId).map((i) => i.name));
        for (const c of present) {
          if (mine.has(c.name) || /-run-[0-9a-f]{6}$/.test(c.name)) continue;
          await hub.command(serverId, 'container.remove', { name: c.name })
            .then(() => log.info(`removed ${c.name} from ${serverId}: it was moved or removed while the server was away`))
            .catch((err) => log.warn(`could not remove ${c.name}: ${err.message}`));
        }
      }
    },

    /**
     * R7: instances on servers offline for `afterMs` or longer are placed again on another online server of their site,
     * when there is room. Resolves { moved, stuck }.
     */
    async replaceLost({ afterMs = REPLACE_AFTER_MS } = {}) {
      if (replacing) return replacing;
      replacing = (async () => {
        const moved = [];
        const stuck = [];
        const state = await read();
        // Unknown on a server that has been away for afterMs, or whose container was gone when it came back.
        const lost = state.instances.filter((i) => i.status === 'unknown'
          && (i.gone || (!hub.isOnline(i.server) && now() - Date.parse(i.unknownSince ?? 0) >= afterMs)));
        for (const inst of lost) {
          try {
            const to = await moveInstance(inst);
            moved.push({ instance: inst.name, from: inst.server, to: to.server, name: to.name });
          } catch (err) {
            stuck.push({ instance: inst.name, reason: err.message });
            const first = await change((st) => {
              const i = st.instances.find((x) => x.name === inst.name);
              if (!i || i.replaceProblem === err.message) return false;
              i.replaceProblem = err.message;
              return true;
            });
            if (first) {
              log.warn(`could not move ${inst.name} off ${inst.server}: ${err.message}`);
              report({ ...tenantOf(inst), change: 'stuck', instance: inst.name, server: inst.server, reason: err.message });
            }
          }
        }
        return { moved, stuck };
      })();
      try {
        return await replacing;
      } finally {
        replacing = null;
      }
    },

    /** Builds the image on every online server of the site. Resolves { image, commit }. */
    async build({ labels, commit, source = {}, runtime, build = {}, region, deployId, signal, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      const targets = await onlineServers(site.id);
      if (!targets.length) throw new CloudError('unavailable', `No server of ${site.name} is online. Start its agent.`);
      const repo = cloneUrl(source.repo);
      if (!repo) throw new CloudError('invalid', 'The source is not a Git repository this runtime can clone (an https:// URL or a GitHub owner/name).');
      const sha = /^[0-9a-f]{7,40}$/.test(commit ?? '') ? commit : null;
      const tag = `noobly/${tenantHash(labels)}/${labels['noobly-workload']}:${sha ?? short(deployId ?? rand(12), 12)}`;
      let actual = sha;
      for (const server of targets) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const stream = `b-${rand(12)}`;
        // Lines are written in order, one at a time, so the deploy log reads like the build did.
        let chain = Promise.resolve();
        onStream(stream, (frame) => {
          if (frame.type !== 'log') return;
          for (const l of frame.lines) if (l.line.trim()) chain = chain.then(() => log_(l.line)).catch(() => {});
        });
        try {
          if (targets.length > 1) await log_(`Building on ${server.hostname}`);
          const args = {
            labels: agentLabels(labels), runtime: runtime ?? 'node22',
            source: { repo, branch: source.branch ?? 'main', ...(sha ? { commit: sha } : {}), ...(source.rootDir ? { rootDir: source.rootDir } : {}) },
            ...(build.buildCommand ? { buildCommand: build.buildCommand } : {}),
            ...(build.startCommand ? { startCommand: build.startCommand } : {}),
          };
          const r = await send(server.id, 'image.build', { ...args, tag, stream, mask: [] }, { timeoutMs: 30 * 60_000 });
          actual = r.commit ?? actual;
          // Another server builds the same commit later (re-placement), so the record pins what was built.
          if (actual) args.source.commit = actual;
          await images.record(tag, { labels: agentLabels(labels), args }, server.id);
        } finally {
          await chain;
          streams.delete(stream);
        }
      }
      return { image: tag, commit: actual };
    },

    /**
     * Starts `instances` new containers of `image`, checks their health, then removes the old ones (R7). A failure
     * removes the new ones and leaves the old ones serving.
     */
    async rollout({ labels, image, instances, plan, region, run, healthCheck, signal, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      const tenantId = labels['noobly-tenant'];
      const online = await onlineServers(site.id);
      if (!online.length) throw new CloudError('unavailable', `No server of ${site.name} is online. Start its agent.`);
      const state = await read();
      const old = state.instances.filter(ofWorkload(labels));
      // Placement (R7): the server with the most free memory first, counting what is reserved there.
      const room = freeOf(state, online, old);
      const taken = new Set(state.instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
      const picks = [];
      for (let n = 0; n < instances; n += 1) {
        const s = room.take(plan);
        if (!s) throw new CloudError('quota', `Site ${site.name} is full: there is no room for ${instances} instance${instances === 1 ? '' : 's'} of ${plan.cpu} CPU and ${plan.memoryMb} MB.`);
        picks.push(s);
      }

      const network = `noobly-t-${tenantHash(labels)}`;
      for (const s of new Set(picks)) await send(s.id, 'network.ensure', { name: network, labels: { ...agentLabels(labels), 'noobly-workload': 'network' } });

      const fresh = [];
      try {
        for (const s of picks) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          const inst = { ...await startInstance({ site, server: s, labels, image, plan, run, tenantId, network, taken }), run: runOf(run), healthPath: healthCheck?.path ?? '/' };
          fresh.push(inst);
          await change((st) => { st.instances.push({ ...inst, status: 'starting' }); });
          await follow(inst);
          await log_(`Started ${inst.name} on ${s.hostname}${inst.hostPort ? ` (port ${inst.port} → ${inst.url})` : ''}`);
        }
        if (run?.port) {
          const path = healthCheck?.path ?? '/';
          await log_(`Waiting for ${fresh.length === 1 ? 'it' : `all ${fresh.length}`} to answer ${path} on port ${run.port}`);
          for (const inst of fresh) await waitHealthy(inst, path, Math.min(MAX_HEALTH_S, healthCheck?.timeoutS ?? MAX_HEALTH_S), log_);
          await log_('Healthy');
        }
      } catch (err) {
        for (const inst of fresh) await hub.command(inst.server, 'container.remove', { name: inst.name }).catch(() => {});
        await change((st) => { st.instances = st.instances.filter((i) => !fresh.some((f) => f.name === i.name)); });
        throw err;
      }
      // The new ones answer: switch over, tell the launcher where the workload answers now, give requests already on
      // their way to the old ones a moment (drainMs), then remove the old ones. No request meets a removed container.
      await change((st) => {
        for (const i of st.instances) if (fresh.some((f) => f.name === i.name)) i.status = 'running';
        st.instances = st.instances.filter((i) => !old.some((o) => o.name === i.name));
      });
      endpointsChanged(tenantId, labels['noobly-workload']);
      if (old.length && drainMs > 0) await new Promise((r) => setTimeout(r, drainMs));
      for (const o of old) await hub.command(o.server, 'container.remove', { name: o.name }).catch((err) => log.warn(`could not remove ${o.name}: ${err.message}`));
      if (old.length) await log_(`Stopped ${old.length} old instance${old.length === 1 ? '' : 's'}`);
      return fresh;
    },

    /** Asks every running instance for its health check (after a rollout that has already waited for it). */
    async health({ labels, path = '/', log: log_ = async () => {} }) {
      const mine = (await read()).instances.filter((i) => ofWorkload(labels)(i) && i.status === 'running' && i.port);
      for (const inst of mine) await waitHealthy(inst, path ?? '/', 30, log_);
      if (mine.length) await log_(`${mine.length} instance${mine.length === 1 ? '' : 's'} answering`);
      return { healthy: mine.length };
    },

    /** stop, start or restart: start and restart create the containers again from their records. */
    async setStatus({ labels, action, region, run, plan }) {
      const mine = (await read()).instances.filter(ofWorkload(labels));
      if (action === 'stop') {
        for (const i of mine) await send(i.server, 'container.stop', { name: i.name }).catch(() => {});
        await change((st) => { for (const i of st.instances) if (ofWorkload(labels)(i)) i.status = 'stopped'; });
        return mine.length;
      }
      if (!mine.length) return 0;
      const image = mine[0].image;
      await api.rollout({ labels, image, instances: mine.length, plan: plan ?? { cpu: mine[0].cpu, memoryMb: mine[0].memoryMb }, region: region ?? mine[0].region, run: run ?? { port: mine[0].port } });
      return mine.length;
    },

    async remove({ labels }) {
      const mine = (await read()).instances.filter(ofWorkload(labels));
      for (const i of mine) await hub.command(i.server, 'container.remove', { name: i.name }).catch((err) => log.warn(`could not remove ${i.name}: ${err.message}`));
      await change((st) => { st.instances = st.instances.filter((i) => !ofWorkload(labels)(i)); });
      endpointsChanged(labels['noobly-tenant'], labels['noobly-workload']);
      await images.forget(labels);
      return mine.length;
    },

    /** Runs a job's container to completion on the least busy online server. */
    async run({ labels, image, command, region, plan = { cpu: 0.5, memoryMb: 512 }, run: runSpec, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      const [server] = await onlineServers(site.id);
      if (!server) throw new CloudError('unavailable', `No server of ${site.name} is online.`);
      const stream = `j-${rand(12)}`;
      let chain = Promise.resolve();
      onStream(stream, (frame) => {
        if (frame.type === 'log') for (const l of frame.lines) chain = chain.then(() => log_(l.line)).catch(() => {});
      });
      try {
        const r = await send(server.id, 'job.run', {
          name: `noobly-${tenantHash(labels).slice(0, 8)}-${labels['noobly-workload']}-run-${rand(6)}`, image, labels: agentLabels(labels), cpu: plan.cpu, memoryMb: plan.memoryMb, stream,
          env: await envFor(labels['noobly-tenant'], runSpec), ...(command ? { command: ['/bin/sh', '-c', command] } : {}),
        }, { timeoutMs: 24 * 3_600_000 });
        await chain;
        await log_(`Exited with code ${r.exitCode}`);
        if (r.exitCode !== 0) throw new CloudError('invalid', `The job exited with code ${r.exitCode}.`);
        return { runId: stream, exitCode: r.exitCode };
      } finally {
        streams.delete(stream);
      }
    },

    async list({ labels = {} } = {}) {
      return (await read()).instances.filter((c) => hasLabels(c, labels));
    },
    async images() {
      return [];
    },
    /** A server's latest totals from its stats stream, or null when it has sent none (metrics.vm). */
    serverStats: (serverId) => serverStats.get(serverId) ?? null,
    /** Where a workload's running instances answer (R10). */
    async endpoints(tenantId, workload) {
      return (await read()).instances.filter((i) => i.labels['noobly-tenant'] === tenantId && i.labels['noobly-workload'] === workload && i.status === 'running' && i.url)
        .map((i) => ({ instance: i.name, server: i.server, url: i.url }));
    },
  };
  return api;
}
