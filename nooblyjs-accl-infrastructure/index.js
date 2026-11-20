// Noobly Cloud as an accelerator (architecture.md §3). A launcher (the accelerators ../app.js, NooblyJS Cloud, or
// server.js when this repo runs on its own) imports this file and calls mount() with its Express app, its shared
// EventEmitter, its nooblyjs-core ServiceRegistry and what it shares (`host`), the same entry point every NooblyJS
// accelerator exports (`mount(app, eventEmitter, serviceRegistry, options)`). The tests do the same with
// test/fixtures/host.js. Nothing here listens on a port.
//
// The accelerator owns its screens: the UI is a module (public/js/module.js) that the launcher's frame loads into its
// content area, and the launcher draws the rail and the sidebar from the description mount() returns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './src/routes/index.js';
import { createRepos } from './src/repos/index.js';
import { createCatalog } from './src/catalog/index.js';
import { createProviders } from './src/providers/index.js';
import { createConfig } from './src/services/config.js';
import { createSecrets } from './src/services/secrets.js';
import { createActivity } from './src/services/activity.js';
import { createOperations } from './src/services/operations.js';
import { createAccounts } from './src/services/accounts.js';
import { createSync } from './src/services/sync.js';
import { createJobs } from './src/services/jobs.js';
import { createCost } from './src/services/cost.js';
import { createSshKeys } from './src/services/ssh-keys.js';
import { createVms } from './src/services/vms.js';
import { createRemote } from './src/remote/index.js';
import { createSummary } from './src/services/summary.js';
import { withWords } from './src/services/event-words.js';
import { seed as seedStory } from './src/seed/index.js';
import { createPlatform } from './src/platform/index.js';
import { spawn } from 'node:child_process';
import { createAgentHub } from './src/services/agents.js';
import { createLocalServers } from './src/platform/local.js';
import { REPLACE_AFTER_MS } from './src/platform/runtime-local.js';
import { createLocalProvider } from './src/providers/local/index.js';
import { checkProvider } from './src/providers/contract.js';
import { startMockAgent } from './agent/mock.js';
import { agentFileRoutes, AGENT_PUBLIC } from './src/routes/agent-files.js';

const NAME = 'infrastructure';
const MOUNT = /^\/[a-z0-9][a-z0-9-]{0,62}$/;
const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const NEEDS = ['express', 'auth', 'requireRole', 'can', 'audit', 'events', 'store', 'people', 'service', 'frame'];
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PROVIDERS = ['mock', 'gcp', 'aws'];

/** Sidebar rows (product.md §5): `path` is relative to the mount path, `icon` names a UI kit icon. */
export const NAV = [
  { key: 'overview', label: 'Overview', path: '/', icon: 'grid' },
  { key: 'vms', label: 'Virtual machines', path: '/vms', icon: 'screen' },
  { key: 'apps', label: 'Apps', path: '/apps', icon: 'box' },
  { key: 'databases', label: 'Databases', path: '/databases', icon: 'layers' },
  { key: 'buckets', label: 'Buckets', path: '/buckets', icon: 'inbox' },
];

/** The operators' row, added only when the platform layer is on (spec 8.1). */
export const PLATFORM_NAV = { key: 'platform', label: 'Platform', path: '/platform', icon: 'cube' };

/** The cloud providers this install may use (INFRA_PROVIDERS, comma-separated; architecture.md §15). */
export function enabledProviders(value = process.env.INFRA_PROVIDERS) {
  const names = String(value || 'mock').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !PROVIDERS.includes(n));
  if (unknown.length) throw new Error(`INFRA_PROVIDERS may list ${PROVIDERS.join(', ')}; not ${unknown.join(', ')}.`);
  return [...new Set(names)];
}

const envNumber = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]));

/**
 * Mounts Noobly Cloud on the launcher's app: the API at `<mountPath>/api/v1`, the browser files and the pages.
 * Every event it emits goes to `host.events` (the launcher's activity and event stream) and to `eventEmitter`, so
 * other code in the launcher can listen for `infrastructure.*` events.
 *
 * @param {import('express').Express} app   the launcher's app (Express 4 or 5)
 * @param {import('node:events').EventEmitter} eventEmitter   the launcher's shared emitter (the one it gave serviceRegistry.initialize())
 * @param {object} serviceRegistry          nooblyjs-core ServiceRegistry, already initialised by the launcher
 * @param {object} options
 * @param {string} [options.mountPath]
 * @param {string} options.dataDir
 * @param {object} options.host
 * @param {number} [options.mockStepMs]   how long one unit of mock cloud work takes (INFRA_MOCK_STEP_MS; tests pass 0)
 * @param {number} [options.jobCheckMs]   how often to check which jobs are due (INFRA_SYNC_CHECK_MS; 0: no timer)
 * @param {{ enabled?: boolean, resolveSecrets?: Function }} [options.platform]   the platform layer for a hosting launcher (spec 8.1);
 *   off unless enabled. resolveSecrets(tenantId, refs) opens the launcher's secretRefs when a container starts (8.9 R9).
 * @param {{ site?: { id: string, name?: string, bind?: string }, agent?: 'fork'|'mock'|null, controller?: string }} [options.local]
 *   local servers (spec 8.9): a site to create on start, and in development an agent on this machine — 'fork' runs the
 *   real agent as a child process (Docker on this machine), 'mock' an in-process one (tests). Needs host.onUpgrade.
 * @param {{ verify?: Function, checkMs?: number, offlineAfterMs?: number, heartbeatMs?: number }} [options.agents]
 *   local servers' agent channel (spec 8.9); on when the host offers onUpgrade. Tests override verify and the timings.
 * @returns {Promise<object>} the HostedApp description, with shutdown()
 */
export async function mount(app, eventEmitter, serviceRegistry, {
  mountPath = '/infrastructure', dataDir, host,
  mockStepMs = envNumber('INFRA_MOCK_STEP_MS', 1200),
  jobCheckMs = envNumber('INFRA_SYNC_CHECK_MS', 60_000),
  platform: platformOption = {},
  agents: agentOptions = {},
  local: localOption = {},
} = {}) {
  // Check everything before mounting anything, so a failed start leaves nothing half-mounted (architecture.md §3.1).
  if (typeof app?.use !== 'function') throw new Error("nooblyjs-accelerator-infrastructure needs the launcher's Express app.");
  if (typeof eventEmitter?.emit !== 'function') throw new Error("nooblyjs-accelerator-infrastructure needs the launcher's EventEmitter.");
  if (!serviceRegistry?.initialized) throw new Error('nooblyjs-accelerator-infrastructure needs an initialised serviceRegistry (the launcher initialises it).');
  if (!MOUNT.test(mountPath ?? '')) throw new Error(`mountPath must look like /infrastructure, not ${JSON.stringify(mountPath)}`);
  if (!dataDir) throw new Error('nooblyjs-accelerator-infrastructure needs a dataDir.');
  const missing = NEEDS.filter((key) => !host?.[key]);
  if (missing.length) throw new Error(`nooblyjs-accelerator-infrastructure needs host.${missing.join(', host.')} from the launcher.`);
  const enabled = enabledProviders();
  if (platformOption !== undefined && platformOption !== null && typeof platformOption !== 'object') throw new Error('options.platform is { enabled: true } or nothing.');
  const platformOn = platformOption?.enabled === true;

  // The launcher's logging and queueing providers, as instances named after this accelerator (never ones of our own).
  const log = serviceRegistry.logger(serviceRegistry.getDefaultProviderType('logging'), { instanceName: NAME });
  const queue = serviceRegistry.queue(serviceRegistry.getDefaultProviderType('queueing'), { instanceName: NAME });
  // Business time comes from the launcher's clock, which a dev clock can move.
  const now = () => new Date(host.clock?.now?.() ?? Date.now()).getTime();

  const repos = createRepos(host.store, { log });
  const config = createConfig({ store: host.store });
  const secrets = await createSecrets({ store: host.store, log, audit: host.audit });
  const catalog = await createCatalog();
  const activity = createActivity({ repos, host, now });
  // Every event from here on carries `system: 'infrastructure'` and its sentence, is kept in the activity log, and is
  // also emitted on the launcher's EventEmitter (a listener that throws never breaks the operation that emitted it).
  const launcherEvents = host.events;
  const mirrored = {
    ...launcherEvents,
    async emit(type, payload, emitOptions) {
      const event = await launcherEvents.emit(type, payload, emitOptions);
      try {
        eventEmitter.emit(type, payload);
      } catch (err) {
        log?.warn(`an ${type} listener failed: ${err.message}`);
      }
      return event;
    },
  };
  host = { ...host, events: withWords(mirrored, { record: activity.record, log }) };
  const providers = createProviders({ enabled, store: host.store, secrets, catalog, mockStepMs, now });
  const operations = createOperations({ repos, host, log, queue, providers, secrets, now, perAccount: envNumber('INFRA_OPS_PER_ACCOUNT', 4), perTenant: envNumber('INFRA_OPS_PER_TENANT', 2) });
  const accounts = createAccounts({ repos, host, operations, providers, secrets, catalog, config, now, log });
  const sync = createSync({ repos, operations, providers, config, host, log, now });
  const cost = createCost({ repos, catalog, store: host.store, now });
  const remote = createRemote({ providers, secrets, config, catalog, repos });
  const sshKeys = createSshKeys({ repos, host, now });
  const vms = createVms({ repos, host, operations, providers, remote, sshKeys, catalog, config, cost, now, log });
  const summary = createSummary({ repos, accounts, activity, cost });
  // The platform layer (spec 8.1): its operation types, records, routes and job exist only when the launcher asks.
  // Local servers (spec 8.9): their records and the agent hub, when the launcher can pass WebSocket upgrades and runs
  // the platform layer. The hub's callbacks reach the platform's local runtime, made just below.
  const localServers = platformOn && typeof host.onUpgrade === 'function' ? createLocalServers({ store: host.store, config, now, log }) : null;
  let platform = null;
  let stopping = false;
  const agents = typeof host.onUpgrade === 'function' ? createAgentHub({
    verify: agentOptions.verify ?? (localServers ? (frame) => localServers.verify(frame) : async () => { throw new Error('This server is not enrolled.'); }),
    now,
    log: { warn: (m) => log.warn(m), info: (m) => log.info(m) },
    onStatus: (server, status) => {
      log.info(`agent ${server} ${status}`);
      if (!localServers || stopping) return;
      localServers.markStatus(server, status === 'online' ? 'online' : 'offline')
        .then((s) => {
          if (!s) return null;
          return status === 'online' ? platform?.localRuntime?.serverOnline(server) : platform?.localRuntime?.serverOffline(server);
        })
        .catch((err) => log.warn(`server ${server}: ${err.message}`));
      try {
        eventEmitter.emit('infrastructure.server.status', { server, status });
      } catch { /* a listener failed */ }
    },
    onFacts: (server, facts) => { localServers?.recordFacts(server, facts).catch((err) => log.warn(`server ${server} facts: ${err.message}`)); },
    onStream: (server, frame) => platform?.localRuntime?.onStream(server, frame),
    ...(agentOptions.checkMs !== undefined ? { checkMs: agentOptions.checkMs } : {}),
    ...(agentOptions.offlineAfterMs !== undefined ? { offlineAfterMs: agentOptions.offlineAfterMs } : {}),
    ...(agentOptions.heartbeatMs !== undefined ? { heartbeatMs: agentOptions.heartbeatMs } : {}),
  }) : null;
  platform = platformOn
    ? createPlatform({
      store: host.store, host, operations, config, catalog, log, now, mockStepMs, workloadsPerTenant: envNumber('INFRA_WORKLOADS_PER_TENANT', 100),
      local: localServers ? { servers: localServers, hub: agents, statsEveryS: localOption.statsEveryS, drainMs: localOption.drainMs } : null,
      resolveSecrets: platformOption.resolveSecrets,
      emitRaw: (type, payload) => eventEmitter.emit(type, payload),
    })
    : null;
  // Spec 8.9.4: a local site through the provider contract (its servers as VMs, metrics from the agent's stats).
  const localProvider = localServers && agents
    ? (site) => checkProvider(createLocalProvider({ site, servers: localServers, hub: agents, runtime: platform?.localRuntime ?? null }))
    : null;
  if (localProvider) providers.useLocal(localProvider);
  const jobs = createJobs({
    now,
    log,
    checkEveryMs: jobCheckMs,
    jobs: [
      { name: 'account-check', every: 15 * 60_000, run: () => accounts.checkAll() },
      { name: 'inventory', every: () => sync.every(), run: () => sync.inventory() },
      { name: 'cost-snapshot', every: 60 * 60_000, run: () => cost.accrue() },
      ...(platform ? [{ name: 'platform-inventory', every: () => sync.every(), run: () => platform.inventory() }] : []),
      // Spec 8.9 R7: instances on a server offline for 5 minutes start again elsewhere in its site.
      ...(platform?.localRuntime ? [{ name: 'local-replace', every: localOption.replaceEveryMs ?? 30_000, run: () => platform.localRuntime.replaceLost({ afterMs: localOption.replaceAfterMs ?? REPLACE_AFTER_MS }) }] : []),
    ],
  });

  /**
   * Writes the seed story; mock accounts get mock credentials, and nothing read before the rewrite is kept. The
   * story's operations under way wait for resume() (or the next start), so a test sees the story as written.
   */
  const seed = async (options) => {
    const result = await seedStory(host.store, { ...options, now, platform: platformOn });
    if (result.seeded) {
      config.forget();
      providers.reset();
      remote.forget();
      platform?.runtime.reset();
      await accounts.seedCredentials();
    }
    return result;
  };

  const router = host.express.Router();
  // install.sh and the agent's files, without a sign-in (spec 8.9 R2): only when local servers are on.
  if (localServers) router.use(agentFileRoutes({ host, mountPath }));
  router.use('/api/v1', createApi({
    host, log, seed, summary, accounts, operations, activity, catalog, cost, vms, sshKeys, platform,
    local: localServers && agents ? { servers: localServers, hub: agents } : null, mountPath,
    about: { name: NAME, version: VERSION, mountPath, providers: enabled },
  }));
  // The browser files (module, pages, CSS). redirect: false, or /infrastructure would 301 to /infrastructure/.
  router.use(host.express.static(PUBLIC_DIR, { index: false, redirect: false }));
  // Every other GET without a file extension is a page: the launcher's frame answers it, so deep links and refresh
  // land on the right screen. A missing .js or .css is still a 404. Middleware rather than a wildcard route, because
  // Express 4 and 5 disagree on wildcard syntax (architecture.md §3.4).
  router.use((req, res, next) => (req.method === 'GET' && !path.extname(req.path) && !req.path.startsWith('/api/') ? host.frame(req, res, next) : next()));
  app.use(mountPath, router);

  // Local servers' agents connect out to <mountPath>/agent/v1 (spec 8.9 R3). The accelerator never listens on a port:
  // the launcher passes its HTTP server's upgrades through host.onUpgrade. Without it, there are no local servers.
  let stopUpgrades = null;
  let localAgent = null;
  if (agents) {
    stopUpgrades = host.onUpgrade(`${mountPath}/agent/v1`, agents.upgradeHandler());
  } else {
    log.info('the launcher has no host.onUpgrade, so local servers cannot connect (spec 8.9)');
  }
  if (localServers) {
    if (localOption.site) await localServers.ensureSite(localOption.site);
    for (const site of await localServers.sites()) platform.addLocalSite(site.id);
    if (localOption.agent && localOption.site) localAgent = await startLocalAgent({ kind: localOption.agent, site: localOption.site.id, controller: localOption.controller, dataDir, localServers, agents, log });
  }

  // Operations that were queued or under way when the server last stopped carry on; the jobs start ticking.
  await operations.recover();
  jobs.start();

  let closing = null;
  const shutdown = () => {
    closing ??= (async () => {
      stopping = true;
      localAgent?.stop();
      if (typeof stopUpgrades === 'function') stopUpgrades();
      await agents?.close();
      await jobs.close();
      await operations.close();
    })();
    return closing;
  };

  return {
    name: NAME,
    label: 'Cloud',
    title: 'Noobly Cloud',
    icon: 'globe',
    mountPath,
    /** Paths under mountPath that answer without a sign-in (the agent's downloads); a gating launcher lets these through. */
    publicPaths: localServers ? [...AGENT_PUBLIC] : [],
    ui: { entry: 'js/module.js', styles: ['css/infrastructure.css'] },
    nav: platform ? [...NAV, PLATFORM_NAV] : NAV,
    /** The sidebar's status card: the cloud accounts and their state (product.md §5). */
    status: () => summary.status(),
    /** What other accelerators may call. */
    services: platform ? { ...summary.services, platform: platform.services } : summary.services,
    /** Writes the seed story into dataDir; `reset` removes what is there first. */
    seed: async ({ reset = false, content = host.sampleData !== false } = {}) => {
      await seed({ reset, content });
    },
    /** Stops the jobs; running operations stop at their next safe point and carry on at the next start. Idempotent. */
    shutdown,
    /** The same as shutdown(), for launchers that close hosted apps by the HostedApp description. */
    close: shutdown,
    /** Carries on with the operations under way on disk (after seeding, as at a start). */
    resume: () => operations.recover(),
    /** The local servers' agent channel (spec 8.9), or null when the launcher cannot pass upgrades. */
    agents,
    /** Local servers (spec 8.9): their records and the development agent, when on. */
    local: localServers ? { servers: localServers, runtime: platform?.localRuntime ?? null, provider: localProvider, get agent() { return localAgent; } } : null,
    /** For the tests: resolves when no operation is queued or running. */
    idle: () => operations.idle(),
    /** For the tests and a person in a hurry: run a job now ('account-check', 'inventory'). */
    runJob: (name) => jobs.run(name),
    /** For the tests and demos: the mock cloud of an account (failAt, outOfBand, resources). */
    /** For the tests and demos, with the platform on: the mock workload runtime (failAt, list, outOfBand). */
    ...(platform ? { mockRuntime: () => platform.runtime } : {}),
    mockCloud: async (accountId) => {
      const account = await repos.accounts.get(accountId);
      return account ? providers.mockCloud(account) : null;
    },
  };
}

/**
 * A development agent on this machine (spec 8.9 exit check): 'mock' runs one in-process on the in-memory Docker;
 * 'fork' runs the real agent (agent/bin/noobly-agent.js) as a child process with --dev, its state in
 * <dataDir>/local-agent. Either enrols with a fresh one-time token the first time; the real one keeps its credential.
 */
async function startLocalAgent({ kind, site, controller, dataDir, localServers, agents, log }) {
  if (kind === 'mock') {
    const { token } = await localServers.createEnrolment(site, { by: 'development' });
    let agent = startMockAgent({ identity: { token } });
    agents.attach(agent.transport, { address: '127.0.0.1' });
    const first = await agent.welcome;
    return {
      kind, docker: agent.docker, welcome: Promise.resolve(first), server: first.server,
      stop: () => agent.session.stop(),
      /** Tests: the same server dialling again with its credential, its containers intact (after a disconnect). */
      async reconnect() {
        agent = startMockAgent({ identity: { server: first.server, credential: first.credential }, docker: agent.docker });
        agents.attach(agent.transport, { address: '127.0.0.1' });
        return agent.welcome;
      },
    };
  }
  if (kind !== 'fork') throw new Error(`local.agent is 'fork', 'mock' or nothing, not ${JSON.stringify(kind)}.`);
  if (!controller) throw new Error('local.controller (this launcher\'s own URL, such as http://127.0.0.1:11010) is needed to fork the agent.');
  const stateDir = path.join(dataDir, 'local-agent');
  const enrolled = fs.existsSync(path.join(stateDir, 'agent.json'));
  const env = { ...process.env };
  if (!enrolled) env.NOOBLY_AGENT_TOKEN = (await localServers.createEnrolment(site, { by: 'development' })).token;
  const bin = fileURLToPath(new URL('./agent/bin/noobly-agent.js', import.meta.url));
  let child = null;
  let stopped = false;
  const start = () => {
    child = spawn(process.execPath, [bin, 'run', '--controller', controller, '--state-dir', stateDir, '--dev'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const out of [child.stdout, child.stderr]) out.on('data', (d) => { for (const line of String(d).split('\n').filter(Boolean)) log.info(`[local agent] ${line.replace(/^\S+ noobly-agent /, '')}`); });
    child.on('exit', (code) => {
      child = null;
      if (!stopped) log.warn(`the local agent stopped (code ${code}); it is not restarted. Restart the app, or delete ${stateDir} to enrol again.`);
    });
  };
  start();
  log.info(`started a local agent for site ${site} (Docker on this machine) → ${controller}`);
  return { kind, stop: () => { stopped = true; child?.kill('SIGTERM'); } };
}
