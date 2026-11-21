// Host pools (spec 8.2 R1, R4, R9; tasks 8.2.1, 8.2.7): the shared VMs a cloud region's instances run on. A pool is an
// operator's record (account, region, zone, size, min and max hosts, purpose); its VMs are ordinary VM records with
// `role: host` (or `builder`, `ingress` for 8.3 and 8.4) and `pool: <name>`, hidden from the VM list like database
// VMs. Each pool host runs the noobly agent (spec 8.9) — installed at first boot with a one-time enrolment token, it
// connects out to this controller — so cloud hosts and local servers share one runtime (runtime-local.js), and a pool
// is a site of `mode: 'pool'` whose servers are its hosts. Decision recorded in spec 8.2 ("Hosts run the agent").
//
// pool.grow adds a host: the VM record, vm.launch (steps 1–2 with the host's cloud-init), then the agent enrolling.
// host.drain cordons a host, moves its instances one at a time (each answering elsewhere before the old one goes),
// then deletes the VM. The runtime calls growFor() when a region is full. On the mock cloud no machine boots, so the
// in-process mock agent (agent/mock.js) enrols in its place, with the facts of the VM's machine type.
//
// Builder pools (spec 8.3 R2, R3): a region's builds run on its builder pool's hosts, never on hosts that serve
// traffic, each within the pool's build limits (a host runs as many builds at once as its allocatable holds, at least
// one), and are pushed to the account's registry; hosts pull with read-only credentials. The runtime calls acquire().
import { CloudError } from '../providers/errors.js';
import { hasArea } from '../providers/contract.js';
import { firewallRules } from '../services/steps/vm.js';
import { WEB_RULES } from '../services/endpoints.js';
import { HOST_PORTS } from '../../agent/protocol.js';
import { HttpError, notFound, conflict, unprocessable } from '../util/errors.js';
import { isResourceName } from '../util/ids.js';
import { startMockAgent } from '../../agent/mock.js';

export const POOL_PURPOSES = ['host', 'builder', 'ingress'];
export const POOL_OPERATIONS = ['pool.grow', 'host.drain'];
const NAME = /^[a-z][a-z0-9-]{0,23}[a-z0-9]$/;
const FILE = (name) => ['pools', `${name}.yaml`];
const siteOf = (name) => `pool-${name}`;
const DEFAULT_RESERVE = { cpu: 0.25, memoryMb: 512 };
const ENROL_PATIENCE_MS = 10 * 60_000;
/** One build's limits (spec 8.3 R2) unless the builder pool says otherwise: what a slot holds, and the time limit. */
export const BUILD_LIMITS = { cpu: 1, memoryMb: 2048, timeoutS: 900 };

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.host          events, audit
 * @param {object} o.repos         vms, accounts
 * @param {object} o.operations
 * @param {object} o.catalog
 * @param {object} o.secrets
 * @param {object} o.servers       local servers (sites, servers, enrolments)
 * @param {object} o.hub           the agent hub
 * @param {object} o.runtime       the local runtime (instances, evacuate, setGrow, setBuilders)
 * @param {object} [o.providers]   the cloud providers (the registry of a builder pool's account, spec 8.3)
 * @param {object} [o.config]      installId() names the registry repository
 * @param {(region: string) => void} o.addRegion   makes a region with a host pool run on the local runtime
 * @param {(region: string) => void} [o.removeRegion]   and back on the mock runtime when its last host pool goes
 * @param {() => string|null} o.controller   the URL agents connect to (INFRA_PUBLIC_URL + mount path)
 * @param {() => number} o.now
 * @param {object} o.log
 */
export function createPools({ store, host, repos, operations, catalog, secrets, servers, hub, runtime, providers = null, config = null, addRegion, removeRegion = () => {}, controller, now, log }) {
  const iso = () => new Date(now()).toISOString();
  const read = (name) => (NAME.test(name ?? '') ? store.readYaml(FILE(name)) : null);
  const mockAgents = new Map(); // vm name → { agent, docker }
  const buildsOn = new Map(); // builder server id → builds running there
  const mockNetwork = new Map(); // private address → mock Docker (a mock ingress reaches mock hosts' containers)
  const emit = (type, payload, actor = null) => host.events.emit(type, { resource: { type: 'pool', name: payload.pool }, ...payload }, { actor });

  async function all() {
    const out = [];
    for (const f of (await store.list(['pools'])) ?? []) if (f.endsWith('.yaml')) {
      const p = await store.readYaml(['pools', f]).catch(() => null);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  const hostVms = async (name) => (await repos.vms.list()).filter((v) => v.pool === name && v.status !== 'deleted');
  const serverOf = async (pool, vmName) => (await servers.servers({ site: siteOf(pool) })).find((s) => s.vm === vmName) ?? null;

  /** A pool as the Platform screen shows it: each host, whether its agent is online, and what is reserved on it. */
  async function view(p) {
    const vms = await hostVms(p.name);
    const srv = await servers.servers({ site: siteOf(p.name) });
    const instances = await runtime.list();
    const hosts = vms.map((vm) => {
      const s = srv.find((x) => x.vm === vm.name) ?? null;
      const mine = s ? instances.filter((i) => i.server === s.id && ['running', 'starting', 'unknown'].includes(i.status)) : [];
      const reserved = { cpu: Math.round(mine.reduce((t, i) => t + i.cpu, 0) * 100) / 100, memoryMb: mine.reduce((t, i) => t + i.memoryMb, 0) };
      const online = Boolean(s && hub.isOnline(s.id));
      return {
        vm: vm.name, status: vm.status, server: s?.id ?? null, online, draining: Boolean(s?.draining),
        statusText: vm.status !== 'running' ? (vm.status === 'starting' ? 'Starting' : vm.status) : !s ? 'Enrolling' : s.draining ? 'Draining' : online ? 'Online' : 'Offline',
        privateIp: vm.observed?.privateIp ?? null, allocatable: s?.allocatable ?? null, reserved, instances: mine.length, warnings: s?.warnings ?? [],
      };
    });
    const ops = (await operations.list({ resource: `pool:${p.name}`, status: 'active' })).length;
    return {
      ...p, site: siteOf(p.name), hosts, online: hosts.filter((h) => h.online && !h.draining).length, growing: ops,
      can: { grow: hosts.length + ops < p.max, delete: hosts.length === 0 && ops === 0 },
    };
  }

  // ---------------------------------------------------------------- operations

  /** Waits for another operation (the host's vm.launch or vm.delete) to finish. */
  async function waitFor(id, signal) {
    for (;;) {
      const op = await operations.get(id);
      if (['succeeded', 'failed', 'cancelled'].includes(op.status)) return op;
      await sleep(100, signal);
    }
  }

  /** On the mock cloud no machine boots: an in-process agent enrols for the VM, with its machine type's facts. */
  async function bootMockAgent(vm, token, account) {
    const cat = catalog.forCloud(account.cloud);
    const type = cat?.machineTypes?.[vm.spec.machineType] ?? { vcpu: 2, memoryGb: 4 };
    const agent = startMockAgent({
      identity: { token },
      dev: false,
      registry: mockRegistry,
      network: mockNetwork,
      facts: {
        hostname: vm.name, os: 'Ubuntu 24.04.1 LTS', cpus: type.vcpu, memoryMb: Math.round(type.memoryGb * 1024),
        addresses: [vm.observed?.privateIp ?? '10.10.0.99'], security: { userns: true, rootless: false, apparmor: true, seccomp: true },
      },
    });
    hub.attach(agent.transport, { address: vm.observed?.privateIp ?? '10.10.0.99' });
    mockAgents.set(vm.name, { agent, docker: agent.docker });
    await agent.welcome;
  }

  operations.define('pool.grow', {
    label: (op) => `Add a host to pool ${op.resource.name}`,
    verb: 'Adding a host',
    steps: [
      {
        key: 'record',
        label: 'Name the host',
        async run(ctx) {
          if (ctx.state.vm) return {};
          const p = await read(ctx.op.resource.name);
          if (!p) throw new CloudError('not_found', `Pool ${ctx.op.resource.name} is gone.`);
          const account = ctx.account;
          const url = controller();
          if (account.provider !== 'mock' && !url) throw new CloudError('invalid', 'Set INFRA_PUBLIC_URL to the https:// address hosts reach this controller on, then add the host again.');
          const taken = new Set((await repos.vms.list()).map((v) => v.name));
          let n = 1;
          while (taken.has(`${p.name}-${n}`)) n += 1;
          const name = `${p.name}-${n}`;
          const { token } = await servers.createEnrolment(siteOf(p.name), { by: 'pool.grow', vm: name });
          const tokenRef = await secrets.put('enrolment', token);
          const cat = catalog.forCloud(account.cloud);
          await repos.vms.write({
            name, role: p.purpose, pool: p.name, account: account.id, status: 'starting',
            spec: {
              region: p.region, zone: p.zone, machineType: p.machineType, image: p.image ?? cat.images[0].id, diskGb: p.diskGb,
              docker: true, proxy: p.purpose === 'ingress', sshKeyId: null, sshFrom: 'none', sshCidr: null,
              agent: { controller: url ?? 'http://127.0.0.1/infrastructure', tokenRef },
            },
            ref: {}, createdAt: iso(), createdBy: ctx.op.requestedBy ?? null,
          });
          await ctx.save({ vm: name, tokenRef });
          await ctx.log(`The new host is ${name}`);
          return {};
        },
      },
      {
        key: 'launch',
        label: 'Launch the machine',
        async run(ctx) {
          let id = ctx.state.launchOp;
          if (!id) {
            id = (await operations.start('vm.launch', { resource: { type: 'vm', name: ctx.state.vm }, account: ctx.account.id, person: ctx.op.requestedBy ?? null })).id;
            await ctx.save({ launchOp: id });
          }
          const done = await waitFor(id, ctx.signal);
          if (done.status !== 'succeeded') throw new CloudError('unavailable', `${ctx.state.vm} did not launch: ${done.error?.message ?? done.status}.`);
          return {};
        },
      },
      {
        key: 'enrol',
        label: 'Wait for its agent',
        async run(ctx) {
          const p = await read(ctx.op.resource.name);
          const vm = await repos.vms.get(ctx.state.vm);
          if (ctx.account.provider === 'mock' && !mockAgents.has(vm.name)) {
            const token = await secrets.get(ctx.state.tokenRef);
            if (token) await bootMockAgent(vm, token, ctx.account);
          }
          const until = now() + ENROL_PATIENCE_MS;
          for (;;) {
            const s = await serverOf(p.name, vm.name);
            if (s && hub.isOnline(s.id) && s.allocatable) {
              await secrets.remove(ctx.state.tokenRef);
              await ctx.log(`${vm.name}'s agent is online: ${s.allocatable.cpu} vCPU and ${s.allocatable.memoryMb} MB to place instances on`);
              return { state: { server: s.id } };
            }
            if (now() > until) throw new CloudError('unavailable', `${vm.name}'s agent did not connect within ${ENROL_PATIENCE_MS / 60_000} minutes. Its serial console says why.`);
            await sleep(200, ctx.signal);
          }
        },
      },
    ],
    async succeeded(ctx) {
      const p = await read(ctx.op.resource.name);
      if (p) await applyFirewall(p.region).catch((err) => log.warn(`firewall for ${p.region}: ${err.message}`));
      await emit('infrastructure.pool.grown', { pool: ctx.op.resource.name, vm: ctx.state.vm, region: p?.region ?? null }, ctx.op.requestedBy?.id ?? null);
    },
  });

  operations.define('host.drain', {
    label: (op) => `Drain ${op.resource.name}`,
    verb: 'Draining',
    steps: [
      {
        key: 'cordon',
        label: 'Stop placing on it',
        async run(ctx) {
          const vm = await repos.vms.get(ctx.op.resource.name);
          const s = vm?.pool ? await serverOf(vm.pool, vm.name) : null;
          if (s) await servers.update(s.id, { draining: true });
          return { state: { server: s?.id ?? null, pool: vm?.pool ?? null } };
        },
      },
      {
        key: 'move',
        label: 'Move its instances',
        async run(ctx) {
          if (!ctx.state.server) return { skipped: true, reason: 'its agent never enrolled' };
          const { moved } = await runtime.evacuate(ctx.state.server, { log: ctx.log });
          return { state: { moved } };
        },
      },
      {
        key: 'delete',
        label: 'Delete the machine',
        async run(ctx) {
          const name = ctx.op.resource.name;
          if (ctx.state.server) {
            await servers.remove(ctx.state.server);
            hub.disconnect(ctx.state.server, 'This host was drained and is being deleted.', { retry: false });
          }
          const mock = mockAgents.get(name);
          if (mock) {
            mock.agent.session.stop();
            mockAgents.delete(name);
          }
          let id = ctx.state.deleteOp;
          if (!id) {
            id = (await operations.start('vm.delete', { resource: { type: 'vm', name }, account: ctx.account.id, person: ctx.op.requestedBy ?? null })).id;
            await ctx.save({ deleteOp: id });
          }
          const done = await waitFor(id, ctx.signal);
          if (done.status !== 'succeeded') throw new CloudError('unavailable', `${name} could not be deleted: ${done.error?.message ?? done.status}.`);
          return {};
        },
      },
    ],
    async succeeded(ctx) {
      const p = ctx.state.pool ? await read(ctx.state.pool) : null;
      if (p) await applyFirewall(p.region).catch((err) => log.warn(`firewall for ${p.region}: ${err.message}`));
      await emit('infrastructure.pool.drained', { pool: ctx.state.pool, vm: ctx.op.resource.name, moved: ctx.state.moved ?? 0 }, ctx.op.requestedBy?.id ?? null);
    },
    /** A drain that could not move everything leaves the host serving, and placing again. */
    async failed(ctx) {
      if (ctx.state?.server && ctx.op.steps?.find((s) => s.key === 'delete')?.status !== 'running') await servers.update(ctx.state.server, { draining: false }).catch(() => {});
    },
  });

  // ---------------------------------------------------------------- the runtime's grower (R4)

  /**
   * A region has no room: add a host to one of its host pools that may grow (the one with fewest hosts), or wait for a
   * host already being added. Resolves true once the new host's agent is online, false when no pool may grow.
   */
  async function growFor({ region, log: log_ = async () => {}, signal }) {
    const candidates = [];
    for (const p of (await all()).filter((x) => x.region === region && x.purpose === 'host' && x.status === 'active')) {
      const v = await view(p);
      if (v.growing) candidates.push({ p, v, waiting: true });
      else if (v.can.grow) candidates.push({ p, v, waiting: false });
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.v.hosts.length - b.v.hosts.length);
    return growPool(candidates[0].p, candidates[0].v, log_, signal);
  }
  runtime.setGrow(growFor);

  /** Adds a host to one pool (or waits for the one being added); true once its agent is online. */
  async function growPool(p, v, log_, signal) {
    let id;
    const noun = p.purpose === 'builder' ? 'builder' : 'host';
    if (v.growing) {
      id = (await operations.list({ resource: `pool:${p.name}`, status: 'active' }))[0]?.id;
      await log_(`Waiting for the ${noun} being added to pool ${p.name}`);
    } else {
      id = (await operations.start('pool.grow', { resource: { type: 'pool', name: p.name }, account: p.account, person: null })).id;
      await log_(`Adding a ${noun} to pool ${p.name} (${v.hosts.length} → ${v.hosts.length + 1} of at most ${p.max})`);
    }
    if (!id) return false;
    const done = await waitFor(id, signal);
    if (done.status !== 'succeeded') {
      await log_(`The new host could not be added: ${done.error?.message ?? done.status}`);
      return false;
    }
    await log_(`The new ${noun} is online`);
    return true;
  }

  // ---------------------------------------------------------------- the hosts' firewall (spec 8.4 R6, task 8.4.6)

  /**
   * A region's pool VMs' inbound rules: a host takes its instances' ports (20000–29999) only from the region's ingress
   * VMs' private addresses; an ingress VM takes HTTP and HTTPS from anywhere; builders take nothing. (Same-tenant
   * traffic between hosts waits for 8.2.8.) Run after a pool grows or loses a host.
   */
  async function applyFirewall(region) {
    const inRegion = (await all()).filter((p) => p.region === region && p.status === 'active');
    const ingressIps = [];
    for (const p of inRegion.filter((x) => x.purpose === 'ingress')) for (const v of await hostVms(p.name)) if (v.observed?.privateIp) ingressIps.push(v.observed.privateIp);
    const instancePorts = [...new Set(ingressIps)].sort().map((ip) => ({ port: HOST_PORTS.min, toPort: HOST_PORTS.max, from: `${ip}/32`, why: 'ingress' }));
    let applied = 0;
    for (const p of inRegion) {
      const extra = p.purpose === 'host' ? instancePorts : p.purpose === 'ingress' ? WEB_RULES : [];
      for (const v of await hostVms(p.name)) {
        if (!v.ref?.instance || v.status === 'deleted') continue;
        const account = await repos.accounts.get(v.account);
        const provider = account && providers ? await providers.forAccount(account) : null;
        if (!provider) continue;
        await provider.compute.setFirewall(v.ref.instance, [...firewallRules(v.spec), ...extra]);
        applied += 1;
      }
    }
    return { applied };
  }

  // ---------------------------------------------------------------- builders and the registry (spec 8.3)

  async function providerOf(accountId) {
    const account = await repos.accounts.get(accountId);
    if (!account || !providers) return null;
    const provider = await providers.forAccount(account);
    return hasArea(provider, 'registry') ? provider : null;
  }
  const repository = async () => `noobly-${String(await config?.installId?.() ?? 'install').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}`;

  /** The mock cloud's side of a mock agent's pushes and pulls: the registry that owns the reference, else a public image. */
  const mockRegistry = {
    async push(ref, image, auth) {
      for (const a of await repos.accounts.list()) {
        const pr = a.provider === 'mock' ? await providerOf(a.id) : null;
        if (pr?.registry.mock?.owns(ref)) return pr.registry.mock.push(ref, image, auth);
      }
      throw new Error(`denied: ${ref.split('/')[0]} is no registry of this install`);
    },
    async pull(ref, auth) {
      for (const a of await repos.accounts.list()) {
        const pr = a.provider === 'mock' ? await providerOf(a.id) : null;
        if (pr?.registry.mock?.owns(ref)) return pr.registry.mock.pull(ref, auth);
      }
      return { labels: {}, digest: `sha256:${'5'.repeat(64)}` }; // a public image: Docker Hub, ghcr.io
    },
  };

  /**
   * A builder for one build in `region` (R2): the least busy online host of the region's builder pool with a free slot,
   * growing the pool when all are busy and it may, else waiting. Null when the region has no builder pool or its
   * account no registry (the runtime then builds on the hosts). Call release() when the build is done.
   */
  async function acquire({ region, log: log_ = async () => {}, signal }) {
    const p = (await all()).find((x) => x.purpose === 'builder' && x.region === region && x.status === 'active');
    if (!p) return null;
    const provider = await providerOf(p.account);
    if (!provider) {
      await log_(`Account ${p.account} has no image registry: building on the hosts`);
      return null;
    }
    const limits = { ...BUILD_LIMITS, ...(p.build ?? {}) };
    const slots = (s) => Math.max(1, Math.min(Math.floor(s.allocatable.cpu / limits.cpu), Math.floor(s.allocatable.memoryMb / limits.memoryMb)));
    let waiting = false;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const online = (await servers.servers({ site: siteOf(p.name) })).filter((s) => hub.isOnline(s.id) && !s.draining && s.allocatable);
      const free = online.filter((s) => (buildsOn.get(s.id) ?? 0) < slots(s))
        .sort((a, b) => (buildsOn.get(a.id) ?? 0) - (buildsOn.get(b.id) ?? 0) || String(a.vm).localeCompare(String(b.vm)));
      if (free.length) {
        const server = free[0];
        buildsOn.set(server.id, (buildsOn.get(server.id) ?? 0) + 1);
        try {
          const { path } = await provider.registry.ensure(region, { name: await repository(), labels: { 'managed-by': 'noobly-cloud' } });
          const c = await provider.registry.pushCredentials(region);
          let released = false;
          return {
            server: { ...server, hostname: server.vm ?? server.hostname }, pool: p.name, path, timeoutS: limits.timeoutS,
            auth: { server: c.server, username: c.username, password: c.password },
            // ECR keeps a repository per image: it is made before the push (other registries need nothing).
            prepare: typeof provider.registry.prepare === 'function' ? (ref) => provider.registry.prepare(ref) : null,
            registry: { account: p.account, region },
            release() {
              if (released) return;
              released = true;
              buildsOn.set(server.id, Math.max(0, (buildsOn.get(server.id) ?? 1) - 1));
            },
          };
        } catch (err) {
          buildsOn.set(server.id, Math.max(0, (buildsOn.get(server.id) ?? 1) - 1));
          throw err;
        }
      }
      const v = await view(p);
      if (v.growing || v.can.grow) {
        if (!(await growPool(p, v, log_, signal)) && !online.length) throw new CloudError('unavailable', `Builder pool ${p.name} has no builder online and could not add one.`);
        continue;
      }
      if (!online.length) throw new CloudError('unavailable', `Builder pool ${p.name} has no builder online.`);
      if (!waiting) await log_(`Waiting for a free builder in pool ${p.name} (${online.length} busy, at its most of ${p.max})`);
      waiting = true;
      await sleep(250, signal);
    }
  }

  runtime.setBuilders?.({
    acquire,
    /** Read-only credentials for a host to pull an image from the registry it was pushed to (R3). */
    async pullAuth(rec) {
      const provider = await providerOf(rec.registry?.account);
      if (!provider) throw new CloudError('unavailable', `The registry of ${rec.ref} is not reachable: its account is gone.`);
      const c = await provider.registry.pullCredentials(rec.registry.region);
      return { server: c.server, username: c.username, password: c.password };
    },
    /** An old image out of the registry (R6). */
    async remove(rec) {
      const provider = await providerOf(rec.registry?.account);
      if (provider) await provider.registry.remove(rec.ref);
    },
    /** The registry's own list, pruned to the last `keep` per workload besides those `inUse` (the retention job). */
    async retain({ keep = 5, inUse = new Set() } = {}) {
      let removed = 0;
      for (const p of (await all()).filter((x) => x.purpose === 'builder')) {
        const provider = await providerOf(p.account);
        if (!provider) continue;
        const { path } = await provider.registry.ensure(p.region, { name: await repository() });
        const byWorkload = new Map();
        for (const img of await provider.registry.list(path)) {
          const k = img.ref.slice(0, img.ref.lastIndexOf(':'));
          byWorkload.set(k, [...(byWorkload.get(k) ?? []), img]);
        }
        for (const list of byWorkload.values()) {
          list.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
          for (const img of list.slice(keep)) {
            if (inUse.has(img.ref)) continue;
            await provider.registry.remove(img.ref);
            removed += 1;
          }
        }
      }
      return { removed };
    },
  });

  // ---------------------------------------------------------------- checking what is asked

  async function validate(body) {
    const fields = {};
    const name = String(body.name ?? '').trim();
    if (!NAME.test(name)) fields.name = 'A pool name is 2 to 25 lower-case letters, digits and hyphens, such as web.';
    else if (await read(name)) fields.name = `There is already a pool ${name}.`;
    const purpose = body.purpose ?? 'host';
    if (!POOL_PURPOSES.includes(purpose)) fields.purpose = 'Hosts, builders or ingress.';
    const account = typeof body.account === 'string' ? await repos.accounts.get(body.account) : null;
    if (!account) fields.account = 'Pick a connected cloud account.';
    const cat = account ? catalog.forCloud(account.cloud) : null;
    const region = cat?.regions.find((r) => r.id === body.region) ?? null;
    if (account && !region) fields.region = `Pick one of ${account.cloud.toUpperCase()}'s regions.`;
    const zone = body.zone ?? region?.zones?.[0];
    if (region && !region.zones.includes(zone)) fields.zone = `Pick a zone of ${region.id}.`;
    const machineType = cat ? (cat.sizes[body.size] ?? (cat.machineTypes[body.machineType] ? body.machineType : cat.sizes[body.size ?? 'medium'])) : null;
    if (cat && !cat.machineTypes[machineType]) fields.size = 'Pick a size.';
    const min = body.min === undefined || body.min === '' ? 1 : Number(body.min);
    const max = body.max === undefined || body.max === '' ? Math.max(3, min) : Number(body.max);
    if (!Number.isInteger(min) || min < 0 || min > 20) fields.min = 'From 0 to 20 hosts.';
    if (!Number.isInteger(max) || max < 1 || max > 50) fields.max = 'From 1 to 50 hosts.';
    else if (Number.isInteger(min) && max < min) fields.max = 'At least the minimum.';
    const diskGb = body.diskGb === undefined || body.diskGb === '' ? 50 : Number(body.diskGb);
    if (!Number.isInteger(diskGb) || diskGb < (cat?.disk?.minGb ?? 10) || diskGb > 2000) fields.diskGb = `From ${cat?.disk?.minGb ?? 10} to 2000 GB.`;
    if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields.', { fields });
    return { name, purpose, account: account.id, cloud: account.cloud, region: region.id, zone, machineType, diskGb, min, max, image: cat.images[0].id };
  }

  return {
    mockAgent: (vmName) => mockAgents.get(vmName) ?? null,
    /** The pool records (ingress, spec 8.4, reads the ingress pools). */
    records: all,
    applyFirewall,

    async list() {
      return Promise.all((await all()).map(view));
    },

    async get(name) {
      const p = await read(name);
      if (!p) throw notFound(`No pool ${name}.`);
      return view(p);
    },

    /** R1: a pool, its site, and `min` hosts on their way. Operators only (the routes check). */
    async create(body, person) {
      const f = await validate(body ?? {});
      const pool = { ...f, systemReserve: DEFAULT_RESERVE, status: 'active', createdAt: iso(), createdBy: person ? { id: person.id, name: person.name ?? person.id } : null };
      await store.writeYaml(FILE(f.name), pool);
      await servers.ensureSite({ id: siteOf(f.name), name: `Pool ${f.name}`, bind: '0.0.0.0', reserve: DEFAULT_RESERVE, mode: 'pool', pool: f.name, region: f.region, purpose: f.purpose, by: person?.id ?? null });
      if (f.purpose === 'host') addRegion(f.region);
      await emit('infrastructure.pool.created', { pool: f.name, region: f.region, min: f.min, max: f.max }, person?.id ?? null);
      const operations_ = [];
      for (let i = 0; i < f.min; i += 1) operations_.push(await operations.start('pool.grow', { resource: { type: 'pool', name: f.name }, account: f.account, person }));
      return { pool: await view(pool), operations: operations_ };
    },

    /** Adds one host (up to max). */
    async grow(name, person) {
      const v = await this.get(name);
      if (!v.can.grow) throw conflict(`Pool ${name} has its most hosts (${v.max}). Raise its maximum first.`);
      return { operation: await operations.start('pool.grow', { resource: { type: 'pool', name }, account: v.account, person }) };
    },

    /** R9: drains a host, then deletes it. */
    async drain(vmName, person) {
      const vm = isResourceName(vmName) ? await repos.vms.get(vmName) : null;
      if (!vm?.pool) throw notFound(`No pool host ${vmName}.`);
      const busy = (await operations.list({ resource: `vm:${vmName}`, status: 'active' }))[0] ?? (await operations.list({ resource: `host:${vmName}`, status: 'active' }))[0];
      if (busy) throw new HttpError(409, 'conflict', `${vmName} is busy: ${busy.label}.`);
      // Its own resource key (host:), not the VM's: the drain ends by running vm.delete on the VM.
      return { operation: await operations.start('host.drain', { resource: { type: 'host', name: vmName }, account: vm.account, person }) };
    },

    /** Removes an empty pool. */
    async remove(name, person) {
      const v = await this.get(name);
      if (!v.can.delete) throw conflict(`Pool ${name} still has ${v.hosts.length} host${v.hosts.length === 1 ? '' : 's'}. Drain them first.`);
      await store.remove(FILE(name));
      await servers.setSiteStatus(siteOf(name), 'deleted');
      if (v.purpose === 'host' && !(await all()).some((p) => p.region === v.region && p.purpose === 'host')) removeRegion(v.region);
      await emit('infrastructure.pool.deleted', { pool: name }, person?.id ?? null);
      return { deleted: name };
    },

    /** On start: regions with host pools run on the local runtime; mock hosts' agents come back. */
    async start() {
      for (const p of await all()) if (p.purpose === 'host' && p.status === 'active') addRegion(p.region);
    },

    stop() {
      for (const { agent } of mockAgents.values()) agent.session.stop();
      mockAgents.clear();
    },
  };
}
