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
//
// Host pools (spec 8.2) run on this same runtime: a pool's VMs run the agent and are the servers of the pool's site, and
// a cloud region with host pools is a place like a LAN site (servers.place(region)). Placement is placement.js: spread
// over hosts, never beyond a pool host's allocatable; when a region's hosts are full, `grow` adds one (up to the pool's
// max) before the operation fails with "Region … is full". A draining host takes nothing new and evacuate() moves its
// instances one at a time. Crashes come from the agent's stats frames (restart counts and states); suspending removes
// a workload's containers and so frees what they reserved.
import crypto from 'node:crypto';
import { CloudError } from '../providers/errors.js';
import { hasLabels } from '../providers/contract.js';
import { HOST_PORTS } from '../../agent/protocol.js';
import { place as placeInstances } from './placement.js';

const FILE = ['local', 'instances.yaml'];
const IMAGES = ['local', 'images.yaml'];
export const REPLACE_AFTER_MS = 5 * 60_000;
/** Images kept per workload (spec 8.3 R6), besides any an instance still runs. */
const KEEP_IMAGES = 5;
const short = (s, n = 12) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
 * @param {(tenantId: string, workload: string, crash: object) => void} [o.onCrash]  an instance exited and Docker restarted it, or gave up (8.2 R7)
 * @param {number} [o.drainMs]  after switching to new instances, how long the old ones keep running for requests in flight
 * @param {number} [o.poolDrainMs]  the same behind a region's ingress (spec 8.4 R4: 30 s), per old instance
 * @param {() => number} o.now
 * @param {{ warn: Function, info: Function }} o.log
 */
export function createLocalRuntime({ store, servers, hub, resolveSecrets = async () => ({}), onLog = () => {}, onInstances = () => {}, onMetrics = () => {}, onEndpoints = () => {}, onCrash = () => {}, drainMs = 2000, poolDrainMs = 30_000, statsEveryS = 10, now, log }) {
  const iso = () => new Date(now()).toISOString();
  /** Site ids this runtime answers for (kept in step with servers.sites()). */
  const siteIds = new Set();
  /** stream id → handler(frame) */
  const streams = new Map();
  /** instance name → its open log stream: a container Docker restarted is followed again (its follow ended). */
  const following = new Map();

  const read = async () => (await store.readYaml(FILE)) ?? { instances: [] };
  const change = (fn) => store.withLock(FILE, async () => {
    const state = await read();
    const result = await fn(state);
    await store.writeYaml(FILE, state);
    return result;
  });

  const endpointsChanged = (tenantId, workload) => {
    try { onEndpoints(tenantId, workload); } catch (err) { log.warn(`an endpoints listener failed: ${err.message}`); }
    // A region's ingress (spec 8.4) follows too; a rolling deploy waits for it instead (rolling()).
    if (ingress) background(ingress.syncWorkload(tenantId, workload).catch((err) => log.warn(`ingress sync for ${tenantId}/${workload}: ${err.message}`)));
  };
  const report = (change) => {
    try { onInstances(change); } catch (err) { log.warn(`an instances listener failed: ${err.message}`); }
    endpointsChanged(change.tenantId, change.workload);
  };
  const tenantOf = (i) => ({ tenantId: i.labels['noobly-tenant'], workload: i.labels['noobly-workload'] });
  /** What each image was built from, so another server can build it again (no registry in v1). */
  const images = {
    read: async () => (await store.readYaml(IMAGES)) ?? { images: {} },
    /**
     * Records an image and which server has it (null: only the registry). Keeps the last KEEP_IMAGES per workload
     * (spec 8.3 R6) and any an instance still runs; the ones dropped go from the registry and the servers (cleanUp).
     */
    async record(tag, spec, serverId) {
      const dropped = [];
      await store.withLock(IMAGES, async () => {
        const st = await images.read();
        const prev = st.images[tag];
        st.images[tag] = { ...spec, builtOn: [...new Set([...(prev?.builtOn ?? []), ...(serverId ? [serverId] : [])])], at: prev?.at ?? iso() };
        const keep = new Set((await read()).instances.map((i) => i.image));
        const byWorkload = new Map();
        for (const [t, v] of Object.entries(st.images)) {
          const k = `${v.labels?.['noobly-tenant']}/${v.labels?.['noobly-workload']}`;
          byWorkload.set(k, [...(byWorkload.get(k) ?? []), [t, v]]);
        }
        for (const list of byWorkload.values()) {
          list.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
          for (const [t, v] of list.slice(KEEP_IMAGES)) {
            if (keep.has(t) || t === tag) continue;
            dropped.push({ tag: t, ...v });
            delete st.images[t];
          }
        }
        await store.writeYaml(IMAGES, st);
      });
      if (dropped.length) background(cleanUp(dropped).catch((err) => log.warn(`could not remove old images: ${err.message}`)));
    },
    async forget(labels) {
      await store.withLock(IMAGES, async () => {
        const st = await images.read();
        for (const [t, v] of Object.entries(st.images)) if (v.labels?.['noobly-tenant'] === labels['noobly-tenant'] && v.labels?.['noobly-workload'] === labels['noobly-workload']) delete st.images[t];
        await store.writeYaml(IMAGES, st);
      });
    },
  };

  const pending = new Set();
  /** Keeps track of work started in the background, so settle() can wait for it at shutdown. */
  const background = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  /** Old images out of the registry and off the servers that have them (best effort: a server offline keeps its copy). */
  async function cleanUp(dropped) {
    for (const rec of dropped) {
      if (rec.ref && builders) await builders.remove(rec).catch((err) => log.warn(`could not remove ${rec.ref}: ${err.message}`));
      for (const id of rec.builtOn ?? []) if (hub.isOnline(id)) await hub.command(id, 'image.remove', { tag: rec.tag }).catch(() => {});
    }
  }

  /** Runs an agent command whose output is a log stream, writing its lines to log_ in order. */
  async function streamed(serverId, name, args, log_, o) {
    const stream = `b-${rand(12)}`;
    let chain = Promise.resolve();
    onStream(stream, (frame) => {
      if (frame.type === 'log') for (const l of frame.lines) if (l.line.trim()) chain = chain.then(() => log_(l.line)).catch(() => {});
    });
    try {
      return await send(serverId, name, { ...args, stream }, o);
    } finally {
      await chain;
      streams.delete(stream);
    }
  }

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

  /** The online servers of a place (a LAN site, or a region's host pools) that take new instances. */
  async function onlineServers(site) {
    return (await servers.servers()).filter((s) => site.sites.includes(s.site) && hub.isOnline(s.id) && !s.draining);
  }

  /** The place a region names: a LAN site, or a cloud region with host pools. */
  async function siteOf(region) {
    const site = await servers.place(region);
    if (!site) throw new CloudError('invalid', `No local site or host pool for ${region}.`);
    return site;
  }
  const fullText = (site, what) => `${site.kind === 'region' ? `Region ${site.id}` : `Site ${site.name}`} is full: ${what}`;
  const noneOnline = (site) => (site.kind === 'region' ? `No host of region ${site.id} is online.` : `No server of ${site.name} is online. Start its agent.`);

  /** Where an instance answers: a pool host's private address, the site's bind address, or the server's first LAN address when it binds all. */
  const hostOf = (site, server) => (site.kind === 'region' || site.bind === '0.0.0.0' ? server.facts?.addresses?.[0] ?? '127.0.0.1' : site.bind);
  /** Where its port is published: on a pool host only its private address (8.4's ingress reaches it there). */
  const bindOf = (site, server) => (site.kind === 'region' ? server.facts?.addresses?.[0] ?? '127.0.0.1' : site.bind);

  /** The pool grower (spec 8.2 R4), set by the pools service: adds a host to a region and resolves once it is online. */
  let grow = null;
  /** Builder pools and the registry (spec 8.3, pools.js): acquire, pullAuth, remove. Null: build on the hosts. */
  let builders = null;
  /** A region's ingress (spec 8.4, ingress.js): has(region), sync(region), syncWorkload(tenantId, name). */
  let ingress = null;
  const keyOf = (labels) => `${labels['noobly-tenant']}/${labels['noobly-workload']}`;
  const RESERVING = ['running', 'starting', 'unknown'];

  /**
   * Picks hosts for `count` instances of `plan` (placement.js), growing a full region by a host at a time while its
   * pools may. Resolves the servers (one per instance) or throws quota with the reason.
   */
  async function choose({ site, plan, count, labels, except = [], exclude = [], log: log_ = async () => {}, signal }) {
    for (let grown = 0; ; grown += 1) {
      const online = (await onlineServers(site)).filter((s) => !exclude.includes(s.id));
      if (!online.length && site.kind !== 'region') throw new CloudError('unavailable', noneOnline(site));
      const state = await read();
      const r = placeInstances({
        hosts: online.map((s) => ({ id: s.id, name: s.hostname ?? s.id, allocatable: s.allocatable ?? { cpu: s.facts?.cpus ?? 0, memoryMb: s.facts?.memoryMb ?? 0 } })),
        instances: state.instances.filter((i) => RESERVING.includes(i.status) && !except.includes(i.name)).map((i) => ({ host: i.server, cpu: i.cpu, memoryMb: i.memoryMb, workload: keyOf(i.labels) })),
        plan, count, workload: keyOf(labels), cpuFloor: site.cpuFloor ?? 1, canGrow: site.kind === 'region' && Boolean(grow) && grown < count + 2,
      });
      if (!r.missing) return r.hosts.map((id) => online.find((s) => s.id === id));
      const what = `there is no room for ${count === 1 ? 'an instance' : `${count} instances`} of ${plan.cpu} CPU and ${plan.memoryMb} MB.`;
      if (!r.grow) throw new CloudError('quota', fullText(site, what));
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      await log_(`Region ${site.id} has no room for ${r.missing === 1 ? 'one more instance' : `${r.missing} more instances`}; adding a host`);
      const added = await grow({ region: site.id, plan, missing: r.missing, log: log_, signal });
      if (!added) throw new CloudError('quota', fullText(site, what));
    }
  }

  /**
   * Follows an instance's output into onLog. Resuming (8.5 R5) asks Docker for lines from `since`, the timestamp of
   * the last line delivered; lines before it, and the last line itself, were delivered already and are dropped.
   */
  async function follow(inst, since = null) {
    const stream = `l-${inst.name.slice(-20)}-${rand(4)}`.replace(/[^a-z0-9-]/g, '');
    const tenantId = inst.labels['noobly-tenant'];
    const workload = inst.labels['noobly-workload'];
    const seen = since ? new Set(inst.logTail ?? []) : null;
    const restartsAtStart = inst.restarts ?? 0;
    following.set(inst.name, stream);
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
      if (frame.type === 'stream-end') {
        streams.delete(stream);
        if (following.get(inst.name) === stream) following.delete(inst.name);
        // The container stopped. If Docker has restarted it already (the stats saw it first), follow it again.
        refollow(inst.name, restartsAtStart).catch(() => {});
      }
    });
    try {
      await hub.command(inst.server, 'logs.follow', { name: inst.name, stream, ...(since ? { since } : {}) });
    } catch (err) {
      if (following.get(inst.name) === stream) following.delete(inst.name);
      streams.delete(stream);
      log.warn(`could not follow ${inst.name}: ${err.message}`);
    }
  }

  /**
   * Follows a container again after Docker restarted it (8.2 R7, 8.5 R5): `docker logs --follow` ends when the
   * container stops. Both the end of a follow and the stats' higher restart count call this; whichever comes second
   * finds the other has happened and resumes from the last line delivered.
   */
  const refollowing = new Set();
  async function refollow(name, restartsBefore = -1) {
    if (following.has(name) || refollowing.has(name)) return;
    refollowing.add(name);
    try {
      const inst = (await read()).instances.find((i) => i.name === name);
      if (!inst || !['running', 'starting'].includes(inst.status) || !hub.isOnline(inst.server)) return;
      if ((inst.restarts ?? 0) <= restartsBefore || following.has(name)) return;
      await follow(inst, inst.logAt ?? null);
    } finally {
      refollowing.delete(name);
    }
  }

  /** Build-time variables as a record keeps them: secrets by reference only. */
  const refsOf = (list) => list.map((e) => (e.secretRef ? { key: e.key, secretRef: e.secretRef } : { key: e.key, value: String(e.value ?? '') }));

  /** The variables marked "available during the build" (spec 8.3 R5), secrets opened. */
  async function buildEnvFor(tenantId, list) {
    const env = (list ?? []).filter((e) => e.value !== undefined || e.secretRef);
    const refs = env.filter((e) => e.secretRef).map((e) => e.secretRef);
    const values = refs.length ? await resolveSecrets(tenantId, refs) : {};
    return env.map((e) => ({ key: e.key, value: e.secretRef ? values[e.secretRef] ?? '' : String(e.value) }));
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

  async function startInstance({ site, server, labels, image, plan, run, tenantId, network, taken, aliases = [] }) {
    const range = { min: Math.max(HOST_PORTS.min, site.ports?.min ?? HOST_PORTS.min), max: Math.min(HOST_PORTS.max, site.ports?.max ?? HOST_PORTS.max) };
    const nextPort = () => {
      for (let p = range.min; p <= range.max; p += 1) if (!taken.has(`${server.id}:${p}`)) { taken.add(`${server.id}:${p}`); return p; }
      throw new CloudError('quota', `${server.hostname} has no free port.`);
    };
    const name = `noobly-${tenantHash(labels).slice(0, 8)}-${labels['noobly-workload']}-${rand(6)}`.slice(0, 108);
    const instLabels = { ...agentLabels(labels), 'noobly-instance': name.slice(-6) };
    const bind = bindOf(site, server);
    const env = await envFor(tenantId, run);
    let hostPort = null;
    // A port something else on the server holds (not one of ours) is skipped: try the next one, a few times.
    for (let attempt = 0; ; attempt += 1) {
      hostPort = run?.port ? nextPort() : null;
      try {
        await send(server.id, 'container.run', {
          name, image, labels: instLabels, network, cpu: plan.cpu, memoryMb: plan.memoryMb,
          ...(aliases.length ? { aliases } : {}),
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
      ...(aliases.length ? { aliases } : {}), restarts: 0,
    };
  }

  /** What an instance record keeps of the run spec to start it again elsewhere: secret refs, never values. */
  const runOf = (run) => (run ? { ...(run.port ? { port: run.port } : {}), env: (run.env ?? []).map((e) => (e.secretRef ? { key: e.key, secretRef: e.secretRef } : { key: e.key, value: String(e.value ?? '') })) } : null);

  /**
   * Makes sure `server` has `image`: pulled from the registry with read-only credentials (spec 8.3 R3), pulled from
   * where a prebuilt image lives (R7), or, with no registry (a LAN site, 8.9 R8), built there from its recorded build.
   */
  async function ensureImage(server, image, log_) {
    const rec = (await images.read()).images[image];
    if (!rec) throw new CloudError('invalid', `There is no record of how ${image} was built; deploy the service again.`);
    if (rec.builtOn?.includes(server.id)) return;
    if (rec.ref) {
      if (!builders) throw new CloudError('unavailable', `${image} is in a registry this controller cannot reach now.`);
      await streamed(server.id, 'image.pull', { ref: rec.ref, tag: image, auth: await builders.pullAuth(rec) }, log_, { timeoutMs: 15 * 60_000 });
    } else if (rec.prebuilt) {
      await streamed(server.id, 'image.pull', { ref: rec.prebuilt, tag: image }, log_, { timeoutMs: 15 * 60_000 });
    } else {
      const env = rec.buildEnv ? await buildEnvFor(rec.labels?.['noobly-tenant'], rec.buildEnv) : [];
      await streamed(server.id, 'image.build', { ...rec.args, tag: image, ...(env.length ? { buildEnv: env } : {}), mask: [] }, log_, { timeoutMs: 30 * 60_000 });
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

  /**
   * A rolling deploy behind an ingress (spec 8.4 R4, R5): start one new instance (maxSurge 1), wait for its health
   * check, add it to rotation (the ingress synced), then take one old instance out of rotation, give its requests
   * drainMs, and stop it; repeat. A failed health check stops the rollout and keeps the old version: the new ones leave
   * rotation and stop, and any old ones already stopped start again. `resize` with the same image and plan (a count
   * change) adds or removes instances without touching the others.
   */
  /**
   * A count change without an ingress (local sites, regions without one): `live` all run `image` at `plan`. Adding
   * starts the new ones, waits until they answer, then puts them in the endpoints; removing takes the extra ones out of
   * the endpoints first (the newest on the busiest server, so the rest stay spread), gives requests in flight drainMs,
   * then removes them. The instances that stay are never restarted. A failed start removes only the new ones.
   */
  async function recount({ site, labels, image, plan, run, healthCheck, aliases, live, instances, signal, log_ }) {
    const tenantId = labels['noobly-tenant'];
    const workload = labels['noobly-workload'];
    const plural = (n) => `${n} instance${n === 1 ? '' : 's'}`;
    if (instances < live.length) {
      const keep = [...live];
      const gone = [];
      while (keep.length > instances) {
        const per = new Map();
        for (const i of keep) per.set(i.server, (per.get(i.server) ?? 0) + 1);
        const busiest = Math.max(...per.values());
        gone.push(...keep.splice(keep.findLastIndex((i) => per.get(i.server) === busiest), 1));
      }
      await change((st) => { st.instances = st.instances.filter((i) => !gone.some((g) => g.name === i.name)); });
      endpointsChanged(tenantId, workload);
      if (drainMs > 0) await sleep(drainMs);
      for (const o of gone) await hub.command(o.server, 'container.remove', { name: o.name }).catch((err) => log.warn(`could not remove ${o.name}: ${err.message}`));
      await log_(`Stopped ${plural(gone.length)}; ${plural(keep.length)} still serving, not restarted`);
      return [];
    }
    if (instances === live.length) return [];

    const picks = await choose({ site, plan, count: instances - live.length, labels, log: log_, signal });
    for (const s of new Set(picks)) await ensureImage(s, image, log_);
    const network = `noobly-t-${tenantHash(labels)}`;
    for (const s of new Set(picks)) await send(s.id, 'network.ensure', { name: network, labels: { ...agentLabels(labels), 'noobly-workload': 'network' } });
    const taken = new Set((await read()).instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
    const fresh = [];
    try {
      for (const s of picks) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const inst = { ...await startInstance({ site, server: s, labels, image, plan, run, tenantId, network, taken, aliases }), run: runOf(run), healthPath: healthCheck?.path ?? '/' };
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
    await change((st) => { for (const i of st.instances) if (fresh.some((f) => f.name === i.name)) i.status = 'running'; });
    endpointsChanged(tenantId, workload);
    await log_(`Added ${plural(fresh.length)}; the ${plural(live.length)} already serving ${live.length === 1 ? 'was' : 'were'} not restarted`);
    return fresh;
  }

  async function rolling({ site, labels, image, instances, plan, run, healthCheck, aliases, resize, signal, log_ }) {
    const tenantId = labels['noobly-tenant'];
    const region = site.id;
    const path = healthCheck?.path ?? '/';
    const budget = Math.min(MAX_HEALTH_S, healthCheck?.timeoutS ?? MAX_HEALTH_S);
    const network = `noobly-t-${tenantHash(labels)}`;
    const mine = (await read()).instances.filter(ofWorkload(labels));
    const stale = mine.filter((i) => i.status === 'stopped');
    if (stale.length) await change((st) => { st.instances = st.instances.filter((i) => !stale.some((s) => s.name === i.name)); });
    const live = mine.filter((i) => i.status !== 'stopped');
    const sameShape = live.length && live.every((o) => o.image === image && o.cpu === plan.cpu && o.memoryMb === plan.memoryMb);

    const startOne = async (img, pl, rn, n, of) => {
      const [server] = await choose({ site, plan: pl, count: 1, labels, log: log_, signal });
      await ensureImage(server, img, log_);
      await send(server.id, 'network.ensure', { name: network, labels: { ...agentLabels(labels), 'noobly-workload': 'network' } });
      const taken = new Set((await read()).instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
      const inst = { ...await startInstance({ site, server, labels, image: img, plan: pl, run: rn, tenantId, network, taken, aliases }), run: runOf(rn), healthPath: path };
      await change((st) => { st.instances.push({ ...inst, status: 'starting' }); });
      await follow(inst);
      await log_(`Started ${inst.name} on ${server.hostname}${of > 1 ? ` (${n} of ${of})` : ''}`);
      try {
        if (rn?.port) await waitHealthy(inst, path, budget, log_);
      } catch (err) {
        await hub.command(inst.server, 'container.remove', { name: inst.name }).catch(() => {});
        await change((st) => { st.instances = st.instances.filter((i) => i.name !== inst.name); });
        throw err;
      }
      await change((st) => { const i = st.instances.find((x) => x.name === inst.name); if (i) i.status = 'running'; });
      if (rn?.port) {
        await ingress.sync(region);
        await log_(`${inst.name} is in rotation`);
      }
      return inst;
    };
    const drainOne = async (o) => {
      await change((st) => { st.instances = st.instances.filter((i) => i.name !== o.name); });
      await ingress.sync(region);
      if (poolDrainMs > 0) await sleep(poolDrainMs);
      await hub.command(o.server, 'container.remove', { name: o.name }).catch((err) => log.warn(`could not remove ${o.name}: ${err.message}`));
      await log_(`Took ${o.name} out of rotation and stopped it`);
    };

    if (resize && sameShape) {
      const fresh = [];
      for (let k = live.length; k < instances; k += 1) fresh.push(await startOne(image, plan, run, k - live.length + 1, instances - live.length));
      for (const o of live.slice(instances).reverse()) await drainOne(o);
      endpointsChanged(tenantId, labels['noobly-workload']);
      return fresh;
    }

    const queue = [...live];
    const fresh = [];
    const removed = [];
    try {
      for (let k = 0; k < instances; k += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        fresh.push(await startOne(image, plan, run, k + 1, instances));
        if (queue.length) {
          const o = queue.shift();
          await drainOne(o);
          removed.push(o);
        }
      }
      while (queue.length) {
        const o = queue.shift();
        await drainOne(o);
        removed.push(o);
      }
    } catch (err) {
      if (fresh.length) {
        await change((st) => { st.instances = st.instances.filter((i) => !fresh.some((f) => f.name === i.name)); });
        await ingress.sync(region).catch(() => {});
        for (const f of fresh) await hub.command(f.server, 'container.remove', { name: f.name }).catch(() => {});
      }
      if (removed.length) {
        await log_(`Starting ${removed.length} instance${removed.length === 1 ? '' : 's'} of the previous version again`);
        for (const [k, o] of removed.entries()) {
          await startOne(o.image, { cpu: o.cpu, memoryMb: o.memoryMb }, o.run ?? run, k + 1, removed.length)
            .catch((e) => log.warn(`could not start ${o.image} again: ${e.message}`));
        }
      }
      endpointsChanged(tenantId, labels['noobly-workload']);
      throw err;
    }
    if (removed.length) await log_(`Replaced ${removed.length} old instance${removed.length === 1 ? '' : 's'}, one at a time`);
    endpointsChanged(tenantId, labels['noobly-workload']);
    return fresh;
  }

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
    // Crashes (8.2 R7): Docker restarted a container (its restart count went up), or gave up after five (exited).
    const states = Array.isArray(frame.containers) ? frame.containers.slice(0, 500) : [];
    for (const raw of states) {
      const inst = byName.get(String(raw?.name ?? ''));
      if (!inst || !['running', 'starting'].includes(inst.status)) continue;
      const restarts = Number.isInteger(raw.restarts) && raw.restarts >= 0 ? raw.restarts : 0;
      const gaveUp = raw.state === 'exited' || raw.state === 'dead';
      if (restarts <= (inst.restarts ?? 0) && !gaveUp) continue;
      const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
      await change((st) => {
        const i = st.instances.find((x) => x.name === inst.name);
        if (!i) return;
        Object.assign(i, { restarts, lastExitCode: exitCode, ...(gaveUp ? { status: 'crashed', crashedAt: iso() } : {}) });
      });
      const { tenantId, workload } = tenantOf(inst);
      try {
        onCrash(tenantId, workload, { instance: inst.name, server: serverId, exitCode, restarts, gaveUp });
      } catch (err) {
        log.warn(`a crash listener failed: ${err.message}`);
      }
      if (gaveUp) endpointsChanged(tenantId, workload);
      else await refollow(inst.name).catch((err) => log.warn(`could not follow ${inst.name} after its restart: ${err.message}`));
    }
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

  /**
   * Starts a copy of an instance on another online server, waits for it, then drops the old one's record. A lost
   * instance (R7) is dropped only if it is still lost; a live one (`live`: its host is draining, 8.2 R9) is switched
   * over like a rollout: the copy serves, the old one gets drainMs for requests in flight, then it is removed.
   */
  async function moveInstance(inst, { live = false } = {}) {
    const site = await siteOf(inst.region);
    const exclude = inst.gone ? [] : [inst.server];
    if (site.kind === 'site' && !(await onlineServers(site)).some((s) => !exclude.includes(s.id))) throw new CloudError('unavailable', `No other server of ${site.name} is online.`);
    const plan = { cpu: inst.cpu, memoryMb: inst.memoryMb };
    const { tenantId, workload } = tenantOf(inst);
    const say = async (line) => onLog(tenantId, workload, [{ at: iso(), out: 'stdout', line: `[noobly] ${line}`, instance: inst.name }]);
    const labelsOnly = Object.fromEntries(Object.entries(inst.labels).filter(([k]) => k !== 'noobly-instance'));
    const [server] = await choose({ site, plan, count: 1, labels: labelsOnly, except: [inst.name], exclude, log: say });
    const state = await read();
    await say(live ? `${inst.server} is being drained; starting ${inst.name} again on ${server.hostname}`
      : inst.gone
        ? `${inst.name} was gone when ${inst.server} came back; starting it again on ${server.hostname}`
        : `${inst.name} has been unreachable since ${inst.unknownSince}; starting it again on ${server.hostname}`);
    await ensureImage(server, inst.image, say);
    const labels = Object.fromEntries(Object.entries(inst.labels).filter(([k]) => k !== 'noobly-instance'));
    const network = `noobly-t-${tenantHash(labels)}`;
    await send(server.id, 'network.ensure', { name: network, labels: { ...labels, 'noobly-workload': 'network' } });
    const taken = new Set(state.instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
    const run = inst.run ?? (inst.port ? { port: inst.port } : null);
    const fresh = { ...await startInstance({ site, server, labels, image: inst.image, plan, run, tenantId, network, taken, aliases: inst.aliases ?? [] }), run: inst.run ?? runOf(run), healthPath: inst.healthPath ?? '/' };
    await change((st) => { st.instances.push({ ...fresh, status: 'starting', replaces: inst.name }); });
    try {
      if (fresh.port) await waitHealthy(fresh, fresh.healthPath, MAX_HEALTH_S, say);
    } catch (err) {
      await hub.command(server.id, 'container.remove', { name: fresh.name }).catch(() => {});
      await change((st) => { st.instances = st.instances.filter((i) => i.name !== fresh.name); });
      throw err;
    }
    // The copy answers: it serves, and the old record goes (a lost one's container is removed if its server comes back).
    const stillLost = await change((st) => {
      const old = st.instances.find((i) => i.name === inst.name);
      const lostStill = live ? Boolean(old) : old?.status === 'unknown';
      for (const i of st.instances) if (i.name === fresh.name) { i.status = 'running'; delete i.replaces; }
      if (lostStill) st.instances = st.instances.filter((i) => i.name !== inst.name);
      return lostStill;
    });
    if (live && stillLost) {
      endpointsChanged(tenantId, workload);
      if (drainMs > 0) await new Promise((r) => setTimeout(r, drainMs));
      await hub.command(inst.server, 'container.remove', { name: inst.name }).catch((err) => log.warn(`could not remove ${inst.name}: ${err.message}`));
    }
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
    /** True when `region` is a local site, or a cloud region with host pools (spec 8.2). */
    handles: (region) => siteIds.has(region),
    addSite: (id) => siteIds.add(id),
    /** A region whose last host pool was deleted runs on the mock runtime again. */
    removeSite: (id) => siteIds.delete(id),
    sites: () => [...siteIds],
    /** The pools service's grower (8.2 R4): ({ region, plan, missing, log, signal }) → Promise<boolean> (a host was added). */
    setGrow: (fn) => { grow = fn; },
    setBuilders: (b) => { builders = b; },
    setIngress: (i) => { ingress = i; },
    /** Waits for background work (ingress syncs, image clean-up) to finish. */
    settle: async () => { while (pending.size) await Promise.allSettled([...pending]); },
    /** The retention job (spec 8.3 R6): registry images beyond each workload's last five, except those still recorded. */
    async retainImages() {
      if (!builders?.retain) return { removed: 0 };
      const inUse = new Set(Object.values((await images.read()).images).map((r) => r.ref).filter(Boolean));
      return builders.retain({ keep: KEEP_IMAGES, inUse });
    },

    /**
     * 8.2 R9: moves every instance off a draining server, one at a time, each started elsewhere and answering before
     * the old one goes. Resolves { moved }; a move that cannot be made throws (the drain stops; nothing is lost).
     */
    async evacuate(serverId, { log: log_ = async () => {} } = {}) {
      const mine = (await read()).instances.filter((i) => i.server === serverId && RESERVING.includes(i.status));
      for (const inst of mine) {
        const to = await moveInstance(inst, { live: true });
        await log_(`Moved ${inst.name} to ${to.server} as ${to.name}`);
      }
      return { moved: mine.length };
    },

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

    /**
     * Builds a workload's image (spec 8.3). In a cloud region with a builder pool and a registry: on one builder, within
     * its limits, then pushed; hosts pull it. Elsewhere (a LAN site, 8.9 R8; a region without builders): on every online
     * server. A prebuilt image (R7) is not built: hosts pull it. Build-time variables (R5) go to the build as a secret.
     * Resolves { image, commit }.
     */
    async build({ labels, commit, source = {}, runtime, build = {}, buildEnv = [], region, deployId, signal, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      const sha = /^[0-9a-f]{7,40}$/.test(commit ?? '') ? commit : null;
      const tagOf = (version) => `noobly/${tenantHash(labels)}/${labels['noobly-workload']}:${version}`;
      if (source.image) {
        const tag = tagOf(short(deployId ?? rand(12), 12));
        await log_(`Using the image ${source.image}: nothing to build`);
        await images.record(tag, { labels: agentLabels(labels), prebuilt: source.image }, null);
        return { image: tag, commit: null };
      }
      const repo = cloneUrl(source.repo);
      if (!repo) throw new CloudError('invalid', 'The source is not a Git repository this runtime can clone (an https:// URL or a GitHub owner/name).');
      const tag = tagOf(sha ?? short(deployId ?? rand(12), 12));
      const env = await buildEnvFor(labels['noobly-tenant'], buildEnv);
      const args = {
        labels: agentLabels(labels), runtime: runtime ?? 'node22',
        source: { repo, branch: source.branch ?? 'main', ...(sha ? { commit: sha } : {}), ...(source.rootDir ? { rootDir: source.rootDir } : {}) },
        ...(build.buildCommand ? { buildCommand: build.buildCommand } : {}),
        ...(build.startCommand ? { startCommand: build.startCommand } : {}),
      };
      // What is recorded (to build again on another server) keeps no variable values: those are fetched again.
      const withEnv = (extra = {}) => ({ ...args, ...extra, ...(env.length ? { buildEnv: env } : {}), mask: [] });

      const builder = site.kind === 'region' && builders ? await builders.acquire({ region, log: log_, signal }) : null;
      if (builder) {
        try {
          await log_(`Building on ${builder.server.hostname} (builder pool ${builder.pool}, up to ${Math.round(builder.timeoutS / 60)} minutes)`);
          const r = await streamed(builder.server.id, 'image.build', withEnv({ tag, timeoutS: builder.timeoutS }), log_, { timeoutMs: (builder.timeoutS + 120) * 1000 });
          const actual = r.commit ?? sha;
          if (actual) args.source.commit = actual;
          const ref = `${builder.path}/${tenantHash(labels)}/${labels['noobly-workload']}:${tag.slice(tag.lastIndexOf(':') + 1)}`;
          if (builder.prepare) await builder.prepare(ref);
          const pushed = await streamed(builder.server.id, 'image.push', { tag, ref, auth: builder.auth }, log_, { timeoutMs: 15 * 60_000 });
          // The builder keeps its build cache, not the image: hosts pull it from the registry.
          await hub.command(builder.server.id, 'image.remove', { tag }).catch(() => {});
          await images.record(tag, { labels: agentLabels(labels), args, ref, digest: pushed.digest ?? null, registry: builder.registry }, null);
          return { image: tag, commit: actual };
        } finally {
          builder.release();
        }
      }

      const targets = await onlineServers(site);
      if (!targets.length && site.kind === 'site') throw new CloudError('unavailable', noneOnline(site));
      if (site.kind === 'region' && targets.length) await log_(`${region} has no builder pool: building on its hosts`);
      let actual = sha;
      for (const server of targets) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        if (targets.length > 1) await log_(`Building on ${server.hostname}`);
        const r = await streamed(server.id, 'image.build', withEnv({ tag }), log_, { timeoutMs: 30 * 60_000 });
        actual = r.commit ?? actual;
        // Another server builds the same commit later (re-placement), so the record pins what was built.
        if (actual) args.source.commit = actual;
        await images.record(tag, { labels: agentLabels(labels), args, ...(buildEnv.length ? { buildEnv: refsOf(buildEnv) } : {}) }, server.id);
      }
      return { image: tag, commit: actual };
    },

    /**
     * Starts `instances` new containers of `image`, checks their health, then removes the old ones (R7). A failure
     * removes the new ones and leaves the old ones serving. With `resize` (a scale) at the same image and plan, only the
     * count changes: new instances join the ones serving, or the extra ones leave; the rest are not touched.
     */
    async rollout({ labels, image, instances, plan, region, run, healthCheck, aliases = [], resize = false, signal, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      // Behind an ingress (spec 8.4 R4): one new instance at a time, each in rotation before an old one leaves it.
      if (site.kind === 'region' && ingress && await ingress.has(region)) return rolling({ site, labels, image, instances, plan, run, healthCheck, aliases, resize, signal, log_ });
      const tenantId = labels['noobly-tenant'];
      const old = (await read()).instances.filter(ofWorkload(labels));
      if (resize && old.length && old.every((o) => o.status === 'running' && o.image === image && o.cpu === plan.cpu && o.memoryMb === plan.memoryMb)) {
        return recount({ site, labels, image, plan, run, healthCheck, aliases, live: old, instances, signal, log_ });
      }
      // Placement (placement.js): spread over the hosts, counting what is reserved there except the old instances, which
      // go once the new ones answer; a full region grows by a host when its pool may (8.2 R4).
      const picks = await choose({ site, plan, count: instances, labels, except: old.map((o) => o.name), log: log_, signal });
      // A host added while placing may not have the image yet: build it there from the recorded build (no registry, R8).
      for (const s of new Set(picks)) await ensureImage(s, image, log_);
      const state = await read();
      const taken = new Set(state.instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));

      const network = `noobly-t-${tenantHash(labels)}`;
      for (const s of new Set(picks)) await send(s.id, 'network.ensure', { name: network, labels: { ...agentLabels(labels), 'noobly-workload': 'network' } });

      const fresh = [];
      try {
        for (const s of picks) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          const inst = { ...await startInstance({ site, server: s, labels, image, plan, run, tenantId, network, taken, aliases }), run: runOf(run), healthPath: healthCheck?.path ?? '/' };
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

    /**
     * stop, start or restart. Stopping (suspend, 8.2 R8) removes the containers and keeps their records as `stopped`,
     * so what they reserved is free; start and restart place them again from those records (a rollout).
     */
    async setStatus({ labels, action, region, run, plan, aliases }) {
      const mine = (await read()).instances.filter(ofWorkload(labels));
      if (action === 'stop') {
        for (const i of mine) await send(i.server, 'container.remove', { name: i.name }).catch(() => {});
        await change((st) => { for (const i of st.instances) if (ofWorkload(labels)(i)) i.status = 'stopped'; });
        endpointsChanged(labels['noobly-tenant'], labels['noobly-workload']);
        return mine.length;
      }
      if (!mine.length) return 0;
      const image = mine[0].image;
      await api.rollout({ labels, image, instances: mine.length, plan: plan ?? { cpu: mine[0].cpu, memoryMb: mine[0].memoryMb }, region: region ?? mine[0].region, run: run ?? { port: mine[0].port }, aliases: aliases ?? mine[0].aliases ?? [] });
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

    /**
     * Runs a job's container to completion on the least busy server (8.2 R6): removed when it exits; resolves its exit
     * code, duration and peak memory whatever the code (the platform decides what a non-zero exit means).
     */
    async run({ labels, image, command, region, plan = { cpu: 0.5, memoryMb: 512 }, run: runSpec, signal, log: log_ = async () => {} }) {
      const site = await siteOf(region);
      const [server] = await choose({ site, plan, count: 1, labels, log: log_, signal });
      await ensureImage(server, image, log_);
      const stream = `j-${rand(12)}`;
      const name = `noobly-${tenantHash(labels).slice(0, 8)}-${labels['noobly-workload']}-run-${rand(6)}`;
      let chain = Promise.resolve();
      onStream(stream, (frame) => {
        if (frame.type !== 'log') return;
        // The run's own output: in the operation's log, and to telemetry like an instance's (spec 8.5), tagged with the run.
        onLog(labels['noobly-tenant'], labels['noobly-workload'], frame.lines.map((l) => ({ ...l, instance: name })));
        for (const l of frame.lines) chain = chain.then(() => log_(l.line)).catch(() => {});
      });
      try {
        const r = await send(server.id, 'job.run', {
          name, image, labels: agentLabels(labels), cpu: plan.cpu, memoryMb: plan.memoryMb, stream,
          env: await envFor(labels['noobly-tenant'], runSpec), ...(command ? { command: ['/bin/sh', '-c', command] } : {}),
        }, { timeoutMs: 24 * 3_600_000 });
        await chain;
        const seconds = Number.isFinite(r.durationMs) ? Math.round(r.durationMs / 100) / 10 : null;
        await log_(`Exited with code ${r.exitCode}${seconds !== null ? ` after ${seconds} s` : ''}${Number.isFinite(r.peakMemoryMb) ? `, at most ${r.peakMemoryMb} MB of ${plan.memoryMb} MB` : ''}`);
        return { runId: stream, server: server.id, exitCode: r.exitCode, durationMs: r.durationMs ?? null, peakMemoryMb: r.peakMemoryMb ?? null };
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
    /** Reads a server's stats and container states once, now (crashes are seen at once rather than at the next tick). */
    async statsNow(serverId) {
      const install = hub.session(serverId)?.install;
      if (!install) return false;
      const stream = `s-now-${rand(8)}`;
      const got = new Promise((resolve) => {
        onStream(stream, (frame) => {
          if (frame.type !== 'stats') return;
          streams.delete(stream);
          onStats(serverId, frame).then(resolve, resolve);
        });
      });
      await send(serverId, 'stats.watch', { labels: { 'noobly-install': install }, intervalS: 60, stream });
      await got;
      await hub.command(serverId, 'logs.stop', { stream }).catch(() => {});
      return true;
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
