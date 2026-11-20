// The local runtime (spec 8.9 R6–R11): the same methods as runtime-mock.js, but instances are containers on the
// enrolled servers of a local site, driven through each server's agent. The platform's operations call it for
// workloads whose region is a local site.
//
// v1 choices, written down: each online server of the site builds the image itself (no registry yet, R8); a rollout
// starts the new instances, checks their health, and only then removes the old ones, so a failed deploy leaves the
// old ones serving; instance records live in local/instances.yaml; runtime logs are followed from the moment an
// instance starts and handed to `onLog`.
import crypto from 'node:crypto';
import { CloudError } from '../providers/errors.js';
import { hasLabels } from '../providers/contract.js';
import { HOST_PORTS } from '../../agent/protocol.js';

const FILE = ['local', 'instances.yaml'];
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
 * @param {() => number} o.now
 * @param {{ warn: Function, info: Function }} o.log
 */
export function createLocalRuntime({ store, servers, hub, resolveSecrets = async () => ({}), onLog = () => {}, now, log }) {
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

  /** Follows an instance's output into onLog. */
  async function follow(inst, since = null) {
    const stream = `l-${inst.name.slice(-20)}-${rand(4)}`.replace(/[^a-z0-9-]/g, '');
    const tenantId = inst.labels['noobly-tenant'];
    const workload = inst.labels['noobly-workload'];
    onStream(stream, (frame) => {
      if (frame.type === 'log') {
        onLog(tenantId, workload, frame.lines.map((l) => ({ ...l, instance: inst.name })));
        const last = frame.lines.at(-1)?.at;
        if (last) change((s) => { const i = s.instances.find((x) => x.name === inst.name); if (i) i.logAt = last; }).catch(() => {});
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

    /** A server came back: follow its instances' logs again from where they stopped (8.5 R5). */
    async serverOnline(serverId) {
      const mine = (await read()).instances.filter((i) => i.server === serverId && i.status === 'running');
      for (const inst of mine) await follow(inst, inst.logAt ?? null);
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
          const r = await send(server.id, 'image.build', {
            tag, labels: agentLabels(labels), runtime: runtime ?? 'node22', stream, mask: [],
            source: { repo, branch: source.branch ?? 'main', ...(sha ? { commit: sha } : {}), ...(source.rootDir ? { rootDir: source.rootDir } : {}) },
            ...(build.buildCommand ? { buildCommand: build.buildCommand } : {}),
            ...(build.startCommand ? { startCommand: build.startCommand } : {}),
          }, { timeoutMs: 30 * 60_000 });
          actual = r.commit ?? actual;
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
      const used = new Map();
      for (const i of state.instances.filter((x) => x.status === 'running' && !old.includes(x))) {
        const u = used.get(i.server) ?? { cpu: 0, memoryMb: 0 };
        used.set(i.server, { cpu: u.cpu + i.cpu, memoryMb: u.memoryMb + i.memoryMb });
      }
      const taken = new Set(state.instances.filter((i) => i.hostPort).map((i) => `${i.server}:${i.hostPort}`));
      const picks = [];
      for (let n = 0; n < instances; n += 1) {
        const free = online.map((s) => {
          const u = used.get(s.id) ?? { cpu: 0, memoryMb: 0 };
          const alloc = s.allocatable ?? { cpu: s.facts?.cpus ?? 0, memoryMb: s.facts?.memoryMb ?? 0 };
          return { s, cpu: alloc.cpu - u.cpu, memoryMb: alloc.memoryMb - u.memoryMb };
        }).filter((f) => f.memoryMb >= plan.memoryMb && f.cpu >= plan.cpu * 0.25).sort((a, b) => b.memoryMb - a.memoryMb);
        if (!free.length) throw new CloudError('quota', `Site ${site.name} is full: there is no room for ${instances} instance${instances === 1 ? '' : 's'} of ${plan.cpu} CPU and ${plan.memoryMb} MB.`);
        const s = free[0].s;
        picks.push(s);
        const u = used.get(s.id) ?? { cpu: 0, memoryMb: 0 };
        used.set(s.id, { cpu: u.cpu + plan.cpu, memoryMb: u.memoryMb + plan.memoryMb });
      }

      const network = `noobly-t-${tenantHash(labels)}`;
      for (const s of new Set(picks)) await send(s.id, 'network.ensure', { name: network, labels: { ...agentLabels(labels), 'noobly-workload': 'network' } });

      const fresh = [];
      try {
        for (const s of picks) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          const inst = await startInstance({ site, server: s, labels, image, plan, run, tenantId, network, taken });
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
      // The new ones answer: switch over, then remove the old ones.
      await change((st) => {
        for (const i of st.instances) if (fresh.some((f) => f.name === i.name)) i.status = 'running';
        st.instances = st.instances.filter((i) => !old.some((o) => o.name === i.name));
      });
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
    /** Where a workload's running instances answer (R10). */
    async endpoints(tenantId, workload) {
      return (await read()).instances.filter((i) => i.labels['noobly-tenant'] === tenantId && i.labels['noobly-workload'] === workload && i.status === 'running' && i.url)
        .map((i) => ({ instance: i.name, server: i.server, url: i.url }));
    },
  };
  return api;
}
