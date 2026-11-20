// The platform layer (spec 8.1): workloads that belong to a launcher's tenants, the in-process API a launcher calls
// (`hosted.services.platform`), the workload operations on the accelerator's operations engine, and the events a
// launcher listens for. It exists only when mount() is given `platform: { enabled: true }`.
//
// Every call takes the tenant first. A workload that is not the tenant's answers not_found, the same as one that does
// not exist. The launcher has already checked that its person may act; `actor` ({ id, name, kind }) is for the audit
// trail and the events.
import crypto from 'node:crypto';
import { newId, isGeneratedId } from '../util/ids.js';
import { HttpError, notFound, conflict, unprocessable, quota } from '../util/errors.js';
import { isCloudError } from '../providers/errors.js';
import { inProgress } from '../services/operations.js';
import { createPlatformRepos } from './repos.js';
import { createMockRuntime } from './runtime-mock.js';
import { createLocalRuntime } from './runtime-local.js';
import { checkSpec, specOf, same, CHANGEABLE, REDEPLOY, RESCALE } from './spec.js';
import { isTenantId, isWorkloadName, KINDS, STATUSES } from './names.js';

export const OPERATION_TYPES = ['workload.create', 'workload.deploy', 'workload.scale', 'workload.restart', 'workload.suspend', 'workload.resume', 'workload.delete', 'workload.job.run'];
export const TRIGGERS = ['push', 'manual', 'config'];
const TONE = { live: 'success', deploying: 'warning', failed: 'danger', suspended: 'neutral', deleting: 'neutral' };
const HOUR = 3_600_000;
const round2 = (n) => Math.round(n * 100) / 100;

/** The actor a call names, as the records keep it. */
function actorOf(actor) {
  if (actor === undefined || actor === null) return null;
  if (typeof actor !== 'object' || typeof actor.id !== 'string' || !actor.id || actor.id.length > 200) {
    throw unprocessable('actor is { id, name, kind }.', { fields: { actor: 'Send { id, name, kind }.' } });
  }
  return { id: actor.id, name: typeof actor.name === 'string' ? actor.name : actor.id, kind: typeof actor.kind === 'string' ? actor.kind : 'person' };
}

function tenantOf(tenantId) {
  if (!isTenantId(tenantId)) throw unprocessable('A tenant id is up to 64 letters, digits, dots, hyphens and underscores.', { fields: { tenantId: 'Send the tenant\'s id.' } });
  return tenantId;
}

/**
 * @param {object} o
 * @param {object} o.store        the accelerator's FsStore
 * @param {object} o.host         events (worded and mirrored to the launcher's EventEmitter), audit
 * @param {object} o.operations   the operations engine
 * @param {object} o.config       labels(), installId()
 * @param {object} o.catalog
 * @param {object} o.log
 * @param {() => number} o.now
 * @param {number} [o.mockStepMs]
 * @param {number} [o.workloadsPerTenant]   INFRA_WORKLOADS_PER_TENANT
 * @param {{ servers: object, hub: object }} [o.local]   local servers (spec 8.9): their records and the agent hub
 * @param {(tenantId: string, refs: string[]) => Promise<Record<string, string>>} [o.resolveSecrets]   the launcher opens secretRefs
 * @param {(type: string, payload: object) => void} [o.emitRaw]   the launcher's EventEmitter, for runtime log lines (not Activity)
 */
export function createPlatform({ store, host, operations, config, catalog, log, now, mockStepMs = 1200, workloadsPerTenant = 100, local = null, resolveSecrets, emitRaw = () => {} }) {
  const repos = createPlatformRepos(store, { log });
  const mockRuntime = createMockRuntime({ store, stepMs: mockStepMs, now });
  const iso = () => new Date(now()).toISOString();
  const regions = new Set(['gcp', 'aws'].flatMap((cloud) => (catalog.forCloud(cloud)?.regions ?? []).map((r) => r.id)));

  // Runtime log lines per workload (spec 8.9 R11), the last LOG_KEEP of them, with a cursor; each batch is also emitted
  // as infrastructure.workload.log on the launcher's EventEmitter (straight, not through Activity).
  const LOG_KEEP = 2000;
  const logBuffers = new Map(); // `${tenant}/${workload}` → { seq, lines: [{ seq, at, out, line, instance }] }
  function onLog(tenantId, workload, lines) {
    const key = `${tenantId}/${workload}`;
    const buf = logBuffers.get(key) ?? { seq: 0, lines: [] };
    const added = lines.map((l) => ({ seq: (buf.seq += 1), at: l.at, out: l.out, line: l.line, instance: l.instance ?? null }));
    buf.lines.push(...added);
    if (buf.lines.length > LOG_KEEP) buf.lines.splice(0, buf.lines.length - LOG_KEEP);
    logBuffers.set(key, buf);
    try {
      emitRaw('infrastructure.workload.log', { tenantId, workload, lines: added });
    } catch (err) {
      log.warn(`an infrastructure.workload.log listener failed: ${err.message}`);
    }
  }

  // Local sites are regions too (spec 8.9 R1); their workloads run on the local runtime, everything else on the mock.
  const localRuntime = local ? createLocalRuntime({ store, servers: local.servers, hub: local.hub, resolveSecrets, onLog, now, log }) : null;
  const pick = (a) => (localRuntime?.handles(a?.region) ? localRuntime : mockRuntime);
  const runtime = {
    name: 'routed',
    build: (a) => pick(a).build(a),
    rollout: (a) => pick(a).rollout(a),
    health: (a) => pick(a).health(a),
    setStatus: (a) => pick(a).setStatus(a),
    remove: (a) => pick(a).remove(a),
    run: (a) => pick(a).run(a),
    list: async (a) => [...await mockRuntime.list(a), ...(localRuntime ? await localRuntime.list(a) : [])],
    images: async (a) => [...await mockRuntime.images(a), ...(localRuntime ? await localRuntime.images(a) : [])],
    // The mock's test hooks.
    failAt: (...args) => mockRuntime.failAt(...args),
    outOfBand: (fn) => mockRuntime.outOfBand(fn),
    reset: () => mockRuntime.reset(),
  };
  /** Registers a local site as a region. */
  function addLocalSite(id) {
    if (!localRuntime) return;
    localRuntime.addSite(id);
    regions.add(id);
  }

  /** R6: the install's labels and the workload's. */
  const labelsFor = (tenantId, name) => config.labels({ 'noobly-tenant': tenantId, 'noobly-workload': name });
  const resourceOf = (tenantId, name) => ({ type: 'workload', tenant: tenantId, name });
  const emit = (type, payload, actor) => host.events.emit(type, { resource: resourceOf(payload.tenantId, payload.workload), ...payload }, { actor: actor?.id ?? null });
  const audit = (actor, action, tenantId, name, extra = {}) => host.audit.record({ actor: actor?.id ?? null, action, target: `workload:${tenantId}/${name}`, tenantId, ...extra });

  const lineOf = (text) => `${iso()}  ${text}\n`;
  /** Appends to a deploy's log. */
  const deployLog = (tenantId, name, deployId) => async (text) => {
    if (!deployId) return;
    await repos.deploys.update(tenantId, name, deployId, (d) => d && { ...d, body: `${d.body ?? ''}${lineOf(text)}` });
  };

  async function setStatus(tenantId, name, status, patch = {}) {
    const before = await repos.workloads.get(tenantId, name);
    const after = await repos.workloads.update(tenantId, name, (w) => w && { ...w, ...patch, status });
    if (after && before?.status !== status) await emit('infrastructure.workload.status', { tenantId, workload: name, status, was: before?.status ?? null });
    return after;
  }

  // ---------------------------------------------------------------- operation types

  /** A context's workload: the operation's tenant and name, read now. */
  const workloadOf = (ctx) => repos.workloads.get(ctx.op.tenant, ctx.op.resource.name);
  const labelsOf = (ctx) => labelsFor(ctx.op.tenant, ctx.op.resource.name);

  const deploySteps = [
    {
      key: 'build',
      label: 'Build the image',
      async run(ctx) {
        const w = await workloadOf(ctx);
        const { deployId, commit } = ctx.input;
        const log = deployLog(ctx.op.tenant, w.name, deployId);
        if (!ctx.state.deployStarted) {
          await repos.deploys.update(ctx.op.tenant, w.name, deployId, (d) => d && { ...d, result: 'building', startedAt: iso() });
          await emit('infrastructure.deploy.started', { tenantId: ctx.op.tenant, workload: w.name, deployId, commit, status: 'building', step: 1, of: 3, trigger: ctx.input.trigger }, ctx.op.requestedBy);
          await ctx.save({ deployStarted: true });
        }
        const built = await runtime.build({ labels: await labelsOf(ctx), commit, source: w.source ?? {}, runtime: w.build?.runtime, build: w.build ?? {}, region: w.region, deployId, signal: ctx.signal, log });
        const { image } = built;
        // A real build says which commit it built (the branch's latest when none was asked for).
        const builtCommit = built.commit && built.commit !== commit ? built.commit.slice(0, 40) : null;
        await repos.deploys.update(ctx.op.tenant, w.name, deployId, (d) => d && { ...d, image, result: 'deploying', ...(builtCommit ? { commit: builtCommit, message: d.message ?? `Latest on ${w.source?.branch}` } : {}) });
        await emit('infrastructure.deploy.progress', { tenantId: ctx.op.tenant, workload: w.name, deployId, commit: builtCommit ?? commit, status: 'deploying', step: 2, of: 3 }, ctx.op.requestedBy);
        return { state: { image, ...(builtCommit ? { commit: builtCommit } : {}) } };
      },
    },
    {
      key: 'rollout',
      label: 'Start the new instances',
      async run(ctx) {
        const w = await workloadOf(ctx);
        if (w.kind === 'job') return { skipped: true, reason: 'a job runs when it is asked to' };
        const log = deployLog(ctx.op.tenant, w.name, ctx.input.deployId);
        await runtime.rollout({ labels: await labelsOf(ctx), image: ctx.state.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, signal: ctx.signal, log });
        await emit('infrastructure.deploy.progress', { tenantId: ctx.op.tenant, workload: w.name, deployId: ctx.input.deployId, commit: ctx.input.commit, status: 'deploying', step: 3, of: 3 }, ctx.op.requestedBy);
        return {};
      },
    },
    {
      key: 'health',
      label: 'Check health',
      async run(ctx) {
        const w = await workloadOf(ctx);
        if (w.kind === 'job') return { skipped: true, reason: 'a job has no health check' };
        await runtime.health({ labels: await labelsOf(ctx), path: w.healthCheck?.path ?? null, region: w.region, signal: ctx.signal, log: deployLog(ctx.op.tenant, w.name, ctx.input.deployId) });
        return {};
      },
    },
  ];

  async function deploySucceeded(ctx) {
    const tenantId = ctx.op.tenant;
    const name = ctx.op.resource.name;
    const { deployId } = ctx.input;
    const commit = ctx.state.commit ?? ctx.input.commit;
    const image = ctx.state.image;
    await repos.deploys.update(tenantId, name, deployId, (d) => d && { ...d, result: 'live', endedAt: iso() });
    const w = await repos.workloads.get(tenantId, name);
    const previous = w?.current?.deployId;
    if (previous && previous !== deployId) await repos.deploys.update(tenantId, name, previous, (d) => d && d.result === 'live' && { ...d, result: 'superseded' });
    await setStatus(tenantId, name, 'live', { current: { deployId, commit: commit ?? null, image } });
    await emit('infrastructure.deploy.succeeded', { tenantId, workload: name, deployId, commit: commit ?? null, status: 'live' }, ctx.op.requestedBy);
  }

  async function deployFailed(ctx, err) {
    const tenantId = ctx.op.tenant;
    const name = ctx.op.resource.name;
    const { deployId, commit } = ctx.input ?? {};
    const reason = ctx.op.error?.message ?? (isCloudError(err) ? err.message : 'Something went wrong. It has been logged.');
    await deployLog(tenantId, name, deployId)(`Failed: ${reason}`);
    await repos.deploys.update(tenantId, name, deployId, (d) => d && { ...d, result: 'failed', endedAt: iso(), reason });
    const w = await repos.workloads.get(tenantId, name);
    if (w?.current?.image && w.kind !== 'job') {
      // The deploy before this one keeps serving: put its instances back (8.4 makes the rollout itself zero-downtime).
      try {
        // The local runtime never stopped the old instances; the mock puts them back.
        if (!localRuntime?.handles(w.region)) await runtime.rollout({ labels: await labelsFor(tenantId, name), image: w.current.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, log: deployLog(tenantId, name, deployId) });
        await deployLog(tenantId, name, deployId)(`Kept ${w.current.commit ?? w.current.image} running`);
      } catch (rollbackErr) {
        log.warn(`platform ${tenantId}/${name}: could not put ${w.current.image} back: ${rollbackErr.message}`);
      }
      await setStatus(tenantId, name, 'live');
    } else if (w) {
      await setStatus(tenantId, name, 'failed');
    }
    await emit('infrastructure.deploy.failed', { tenantId, workload: name, deployId, commit: commit ?? null, status: 'failed', reason, step: ctx.op.error?.step ?? null }, ctx.op.requestedBy);
  }

  async function deployCancelled(ctx) {
    const tenantId = ctx.op.tenant;
    const name = ctx.op.resource.name;
    await repos.deploys.update(tenantId, name, ctx.input.deployId, (d) => d && { ...d, result: 'cancelled', endedAt: iso() });
    const w = await repos.workloads.get(tenantId, name);
    if (w) await setStatus(tenantId, name, w.current ? 'live' : 'failed');
  }

  const name_ = (op) => `${op.resource.name} (${op.tenant})`;
  operations.define('workload.create', {
    label: (op) => `Create ${name_(op)}`,
    verb: 'Creating',
    steps: [
      {
        key: 'prepare',
        label: 'Prepare the workload',
        async run(ctx) {
          // The labels go in the operation's log (operators), not the deploy log a launcher shows its tenant.
          const labels = await labelsOf(ctx);
          await ctx.log(`Labels: ${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(', ')}`);
          return {};
        },
      },
      ...deploySteps,
    ],
    succeeded: deploySucceeded,
    failed: deployFailed,
    cancelled: deployCancelled,
  });
  operations.define('workload.deploy', {
    label: (op) => `Deploy ${name_(op)}${op.input.commit ? ` ${op.input.commit}` : ''}`,
    verb: 'Deploying',
    steps: deploySteps,
    succeeded: deploySucceeded,
    failed: deployFailed,
    cancelled: deployCancelled,
  });
  operations.define('workload.scale', {
    label: (op) => `Scale ${name_(op)}`,
    verb: 'Scaling',
    steps: [
      {
        key: 'rollout',
        label: 'Restart at the new size',
        async run(ctx) {
          const w = await workloadOf(ctx);
          await runtime.rollout({ labels: await labelsOf(ctx), image: w.current.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, signal: ctx.signal, log: ctx.log });
          return {};
        },
      },
      {
        key: 'health',
        label: 'Check health',
        async run(ctx) {
          const w = await workloadOf(ctx);
          await runtime.health({ labels: await labelsOf(ctx), path: w.healthCheck?.path ?? null, region: w.region, signal: ctx.signal, log: ctx.log });
          return {};
        },
      },
    ],
  });
  const simple = (type, verb, label, key, stepLabel, action, after) => operations.define(type, {
    label: (op) => `${label} ${name_(op)}`,
    verb,
    steps: [{
      key,
      label: stepLabel,
      async run(ctx) {
        const w = await workloadOf(ctx);
        await runtime.setStatus({ labels: await labelsOf(ctx), action, region: w?.region, run: w?.run, plan: w?.plan, signal: ctx.signal });
        return {};
      },
    }],
    succeeded: after,
  });
  simple('workload.restart', 'Restarting', 'Restart', 'restart', 'Restart the instances', 'restart');
  simple('workload.suspend', 'Suspending', 'Suspend', 'stop', 'Stop the instances', 'stop', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'suspended'));
  simple('workload.resume', 'Resuming', 'Resume', 'start', 'Start the instances', 'start', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'live'));
  operations.define('workload.delete', {
    label: (op) => `Delete ${name_(op)}`,
    verb: 'Deleting',
    steps: [{
      key: 'remove',
      label: 'Remove the instances and images',
      async run(ctx) {
        const w = await workloadOf(ctx);
        const removed = await runtime.remove({ labels: await labelsOf(ctx), region: w?.region, signal: ctx.signal });
        await ctx.log(`Removed ${removed} instance${removed === 1 ? '' : 's'}`);
        return {};
      },
    }],
    async succeeded(ctx) {
      const tenantId = ctx.op.tenant;
      const name = ctx.op.resource.name;
      await repos.workloads.remove(tenantId, name);
      await emit('infrastructure.workload.deleted', { tenantId, workload: name }, ctx.op.requestedBy);
    },
    async failed(ctx) {
      const w = await repos.workloads.get(ctx.op.tenant, ctx.op.resource.name);
      if (w) await setStatus(ctx.op.tenant, w.name, w.statusBeforeDelete ?? 'failed');
    },
  });
  operations.define('workload.job.run', {
    label: (op) => `Run ${name_(op)}`,
    verb: 'Running',
    steps: [{
      key: 'run',
      label: 'Run the job',
      async run(ctx) {
        const w = await workloadOf(ctx);
        const result = await runtime.run({ labels: await labelsOf(ctx), image: w.current.image, command: ctx.input.command ?? w.run?.command ?? null, region: w.region, plan: w.plan, run: w.run, signal: ctx.signal, log: ctx.log });
        return { state: result };
      },
    }],
    async succeeded(ctx) {
      await repos.workloads.update(ctx.op.tenant, ctx.op.resource.name, (w) => w && { ...w, lastRun: { operation: ctx.op.id, result: 'succeeded', exitCode: ctx.state.exitCode ?? 0, at: iso() } });
    },
    async failed(ctx) {
      await repos.workloads.update(ctx.op.tenant, ctx.op.resource.name, (w) => w && { ...w, lastRun: { operation: ctx.op.id, result: 'failed', at: iso() } });
    },
  });

  // ---------------------------------------------------------------- helpers for the API

  async function mustGet(tenantId, name) {
    tenantOf(tenantId);
    const w = isWorkloadName(name) ? await repos.workloads.get(tenantId, name) : null;
    if (!w) throw notFound(`No workload ${name}.`);
    return w;
  }

  const activeOp = async (tenantId, name) => (await operations.list({ resource: `workload:${tenantId}/${name}`, status: 'active' }))[0] ?? null;

  function view(w) {
    if (!w) return null;
    const { body: _body, statusBeforeDelete: _sbd, ...rest } = w;
    return { ...rest, statusText: rest.status ? rest.status[0].toUpperCase() + rest.status.slice(1) : 'Unknown', tone: TONE[rest.status] ?? 'neutral' };
  }

  const deployView = ({ body: _body, ...d }) => d;
  const parseLog = (body) => String(body ?? '').split('\n').filter(Boolean).map((l) => ({ at: l.slice(0, 24), text: l.slice(26) }));

  /** A domain is the install's to give once: another workload (any tenant) with it is a conflict, without saying whose. */
  async function checkDomains(tenantId, name, domains) {
    if (!domains?.length) return;
    for (const t of await repos.tenants()) {
      for (const other of await repos.workloads.list(t)) {
        if (t === tenantId && other.name === name) continue;
        const taken = domains.find((d) => other.domains?.includes(d));
        if (taken) throw conflict(`${taken} is already in use.`, { fields: { domains: `${taken} is already in use.` } });
      }
    }
  }

  /** Starts a deploy: its record first, then the operation (create's first deploy or a later one). */
  async function startDeploy(type, tenantId, w, { commit, trigger, actor, message }) {
    const deployId = newId('dep');
    // A local site builds for real and reports the commit it built; elsewhere the mock makes one up.
    const sha = commit ?? (w.source?.repo && !localRuntime?.handles(w.region) ? mockCommit() : null);
    await repos.deploys.write(tenantId, w.name, {
      id: deployId, commit: sha, message: message ?? (w.source?.repo ? `Latest on ${w.source.branch}` : `Image ${w.source?.image}`), trigger, by: actor,
      operation: null, image: null, result: 'queued', createdAt: iso(), startedAt: null, endedAt: null, body: lineOf(`Queued by ${actor?.name ?? 'the platform'} (${trigger})`),
    });
    const operation = await operations.start(type, { resource: resourceOf(tenantId, w.name), tenant: tenantId, input: { deployId, commit: sha, trigger }, person: actor });
    await repos.deploys.update(tenantId, w.name, deployId, (d) => d && { ...d, operation: operation.id });
    return { operation, deployId };
  }

  /** Until 8.3 reads the repository, a deploy without a commit gets a made-up one, as the mock cloud would. */
  const mockCommit = () => crypto.randomBytes(4).toString('hex').slice(0, 7);

  function checkCommit(commit, message) {
    if (commit !== undefined && commit !== null && !/^[0-9a-f]{7,40}$/.test(commit)) throw unprocessable('commit is a Git commit id.', { fields: { commit: '7 to 40 hex characters.' } });
    if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > 500)) throw unprocessable('message is up to 500 characters.', { fields: { message: 'Up to 500 characters.' } });
  }

  function refuseWhile(w, statuses, message) {
    if (statuses.includes(w.status)) throw new HttpError(409, 'conflict', message);
  }

  // ---------------------------------------------------------------- services.platform

  const workloads = {
    /** Creates a workload and starts its first deploy (of `commit`, or the branch's latest). → { workload, operation } */
    async create(tenantId, spec, { actor, commit, message } = {}) {
      tenantOf(tenantId);
      const by = actorOf(actor);
      checkCommit(commit, message);
      const checked = checkSpec(spec, { regions });
      if (await repos.workloads.get(tenantId, checked.name)) throw conflict(`There is already a workload called ${checked.name}.`, { fields: { name: 'Taken in this workspace.' } });
      if ((await repos.workloads.list(tenantId)).length >= workloadsPerTenant) throw quota(`A tenant may have up to ${workloadsPerTenant} workloads.`);
      await checkDomains(tenantId, checked.name, checked.domains);
      const record = { tenantId, ...checked, status: 'deploying', current: null, createdAt: iso(), createdBy: by };
      await repos.workloads.write(tenantId, record);
      await audit(by, 'workload.created', tenantId, checked.name, { kind: checked.kind });
      await emit('infrastructure.workload.created', { tenantId, workload: checked.name, kind: checked.kind, region: checked.region }, by);
      const { operation } = await startDeploy('workload.create', tenantId, record, { trigger: 'manual', actor: by, commit: commit ?? undefined, message });
      return { workload: view(await repos.workloads.get(tenantId, checked.name)), operation };
    },

    async get(tenantId, name) {
      const w = await mustGet(tenantId, name);
      return { ...view(w), operation: await activeOp(tenantId, name) };
    },

    /** Every workload of the tenant, by name; `kind` and `status` narrow it. */
    async list(tenantId, { kind, status } = {}) {
      tenantOf(tenantId);
      if (kind !== undefined && !KINDS.includes(kind)) throw unprocessable(`kind is one of ${KINDS.join(', ')}.`, { fields: { kind: 'Unknown kind.' } });
      if (status !== undefined && !STATUSES.includes(status)) throw unprocessable(`status is one of ${STATUSES.join(', ')}.`, { fields: { status: 'Unknown status.' } });
      return (await repos.workloads.list(tenantId))
        .filter((w) => !kind || w.kind === kind)
        .filter((w) => !status || w.status === status)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(view);
    },

    /**
     * Changes the spec. A change to the source, build or run (env, port, command) redeploys; plan or instances alone
     * restart at the new size; domains, health check, auto-deploy and schedule change the record only.
     * → { workload, operation } (operation null when nothing had to run)
     */
    async update(tenantId, name, changes, { actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw unprocessable('Send the fields to change.', { fields: { changes: 'Send an object.' } });
      const fixed = Object.keys(changes).filter((k) => !CHANGEABLE.includes(k));
      if (fixed.length) throw unprocessable(`${fixed.join(', ')} can't be changed.`, { fields: Object.fromEntries(fixed.map((k) => [k, 'Fixed once the workload exists.'])) });
      refuseWhile(w, ['deleting'], `${name} is being deleted.`);
      const merged = { ...specOf(w) };
      for (const [key, value] of Object.entries(changes)) {
        const mergeable = ['source', 'build', 'run', 'healthCheck'].includes(key) && value && typeof value === 'object' && !Array.isArray(value) && merged[key];
        merged[key] = mergeable ? { ...merged[key], ...value } : value;
      }
      // A source that switches between repo and image replaces the old one.
      if (changes.source?.image !== undefined) merged.source = { image: changes.source.image };
      else if (changes.source?.repo !== undefined && w.source?.image) merged.source = { ...changes.source };
      const checked = checkSpec(merged, { regions });
      const changed = CHANGEABLE.filter((k) => !same(checked[k], w[k]));
      if (!changed.length) return { workload: view(w), operation: null };
      if (changed.includes('domains')) await checkDomains(tenantId, name, checked.domains);

      const updated = await repos.workloads.update(tenantId, name, (r) => r && { ...r, ...Object.fromEntries(changed.map((k) => [k, checked[k]])) });
      await audit(by, 'workload.updated', tenantId, name, { changed });
      await emit('infrastructure.workload.updated', { tenantId, workload: name, changed }, by);

      let operation = null;
      if (changed.some((k) => REDEPLOY.includes(k)) && w.status !== 'suspended') {
        await setStatus(tenantId, name, 'deploying');
        ({ operation } = await startDeploy('workload.deploy', tenantId, updated, { trigger: 'config', actor: by, message: `Changed ${changed.join(', ')}` }));
      } else if (changed.some((k) => RESCALE.includes(k)) && w.current?.image && w.status !== 'suspended' && w.kind !== 'job') {
        operation = await operations.start('workload.scale', { resource: resourceOf(tenantId, name), tenant: tenantId, input: { instances: checked.instances, plan: checked.plan }, person: by });
      }
      return { workload: view(await repos.workloads.get(tenantId, name)), operation };
    },

    /** Builds and rolls out a commit (or the branch's latest). → { workload, operation } */
    async deploy(tenantId, name, { commit, trigger = 'manual', message, actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      if (!TRIGGERS.includes(trigger)) throw unprocessable(`trigger is one of ${TRIGGERS.join(', ')}.`, { fields: { trigger: 'Unknown trigger.' } });
      checkCommit(commit, message);
      refuseWhile(w, ['deleting'], `${name} is being deleted.`);
      refuseWhile(w, ['suspended'], `${name} is suspended. Resume it to deploy.`);
      await setStatus(tenantId, name, 'deploying');
      await audit(by, 'workload.deployed', tenantId, name, { trigger, commit: commit ?? null });
      const { operation } = await startDeploy('workload.deploy', tenantId, w, { commit, trigger, actor: by, message });
      return { workload: view(await repos.workloads.get(tenantId, name)), operation };
    },

    /** Changes the instance count or plan: a rolling restart, no rebuild. → { workload, operation } */
    async scale(tenantId, name, { instances, plan } = {}, { actor } = {}) {
      const changes = {};
      if (instances !== undefined) changes.instances = instances;
      if (plan !== undefined) changes.plan = plan;
      if (!Object.keys(changes).length) throw unprocessable('Send instances, plan or both.', { fields: { instances: 'Send a count.', plan: 'Or a plan.' } });
      return workloads.update(tenantId, name, changes, { actor });
    },

    async restart(tenantId, name, { actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      refuseWhile(w, ['deleting', 'suspended'], w.status === 'suspended' ? `${name} is suspended. Resume it instead.` : `${name} is being deleted.`);
      if (!w.current?.image || w.kind === 'job' || w.kind === 'static') throw new HttpError(409, 'conflict', `${name} has nothing running to restart.`);
      await audit(by, 'workload.restarted', tenantId, name);
      const operation = await operations.start('workload.restart', { resource: resourceOf(tenantId, name), tenant: tenantId, person: by });
      return { workload: view(w), operation };
    },

    async suspend(tenantId, name, { actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      refuseWhile(w, ['deleting', 'suspended'], w.status === 'suspended' ? `${name} is already suspended.` : `${name} is being deleted.`);
      await audit(by, 'workload.suspended', tenantId, name);
      const operation = await operations.start('workload.suspend', { resource: resourceOf(tenantId, name), tenant: tenantId, person: by });
      return { workload: view(w), operation };
    },

    async resume(tenantId, name, { actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      if (w.status !== 'suspended') throw new HttpError(409, 'conflict', `${name} is not suspended.`);
      await audit(by, 'workload.resumed', tenantId, name);
      const operation = await operations.start('workload.resume', { resource: resourceOf(tenantId, name), tenant: tenantId, person: by });
      return { workload: view(w), operation };
    },

    /** Deletes the workload, its instances, images and deploy history. → { workload, operation } */
    async remove(tenantId, name, { actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      refuseWhile(w, ['deleting'], `${name} is already being deleted.`);
      await repos.workloads.update(tenantId, name, (r) => r && { ...r, statusBeforeDelete: r.status });
      await setStatus(tenantId, name, 'deleting');
      await audit(by, 'workload.deleted', tenantId, name);
      const operation = await operations.start('workload.delete', { resource: resourceOf(tenantId, name), tenant: tenantId, person: by });
      return { workload: view(await repos.workloads.get(tenantId, name)), operation };
    },

    /** Runs a job once (the launcher keeps any schedule). → { workload, operation } */
    async runJob(tenantId, name, { command, actor } = {}) {
      const w = await mustGet(tenantId, name);
      const by = actorOf(actor);
      if (w.kind !== 'job') throw unprocessable(`${name} is a ${w.kind}, not a job.`, { fields: { name: 'Not a job.' } });
      if (command !== undefined && command !== null && (typeof command !== 'string' || command.length > 500)) throw unprocessable('command is up to 500 characters.', { fields: { command: 'Up to 500 characters.' } });
      refuseWhile(w, ['deleting', 'suspended'], `${name} is ${w.status}.`);
      if (!w.current?.image) throw new HttpError(409, 'conflict', `${name} has no image yet. Wait for its first deploy.`);
      await audit(by, 'workload.job.run', tenantId, name);
      const operation = await operations.start('workload.job.run', { resource: resourceOf(tenantId, name), tenant: tenantId, input: { command: command ?? null }, person: by });
      return { workload: view(w), operation };
    },
  };

  const deploys = {
    /** Newest first. `cursor` is the id of the last deploy of the previous page. → { deploys, next } */
    async list(tenantId, name, { limit = 20, cursor } = {}) {
      await mustGet(tenantId, name);
      const all = (await repos.deploys.list(tenantId, name)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
      const n = Math.max(1, Math.min(100, Number(limit) || 20));
      const from = cursor ? all.findIndex((d) => d.id === cursor) + 1 : 0;
      if (cursor && from === 0) throw unprocessable('Unknown cursor.', { fields: { cursor: 'Start again without it.' } });
      const page = all.slice(from, from + n);
      return { deploys: page.map(deployView), next: from + n < all.length ? page.at(-1).id : null };
    },
    async get(tenantId, name, deployId) {
      await mustGet(tenantId, name);
      const d = isGeneratedId(deployId) ? await repos.deploys.get(tenantId, name, deployId) : null;
      if (!d) throw notFound(`No deploy ${deployId}.`);
      return { ...deployView(d), log: parseLog(d.body) };
    },
  };

  /** Reserved CPU and memory over a window, from the current plans (per-hour history arrives with 8.5). */
  async function usage(tenantId, { from, to } = {}) {
    tenantOf(tenantId);
    const end = to ? Date.parse(to) : now();
    const start = from ? Date.parse(from) : Date.parse(`${new Date(end).toISOString().slice(0, 7)}-01T00:00:00.000Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw unprocessable('from and to are ISO times, from before to.', { fields: { from: 'An ISO time.', to: 'An ISO time.' } });
    const rows = [];
    for (const w of await repos.workloads.list(tenantId)) {
      const running = w.status !== 'suspended' && w.current && w.kind !== 'job' && w.kind !== 'static';
      const since = Math.max(start, Date.parse(w.createdAt) || start);
      const hours = running ? Math.max(0, Math.min(end, now()) - since) / HOUR : 0;
      rows.push({ workload: w.name, cpuHours: round2(w.plan.cpu * w.instances * hours), memoryGbHours: round2((w.plan.memoryMb / 1024) * w.instances * hours) });
    }
    return {
      tenantId,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      reserved: { cpuHours: round2(rows.reduce((s, r) => s + r.cpuHours, 0)), memoryGbHours: round2(rows.reduce((s, r) => s + r.memoryGbHours, 0)) },
      bandwidthGb: null,
      workloads: rows,
      note: 'Reserved from the current plans; hour-by-hour usage and bandwidth arrive with spec 8.5.',
    };
  }

  /** Per region: hosts (spec 8.2) and what the running instances reserve. Operators only. */
  async function capacity() {
    const containers = await runtime.list({ labels: { 'noobly-install': await config.installId() } });
    const byRegion = new Map();
    for (const c of containers.filter((x) => x.status === 'running')) {
      const r = byRegion.get(c.region) ?? { region: c.region, hosts: 0, instances: 0, reserved: { cpu: 0, memoryMb: 0 }, free: null };
      r.instances += 1;
      r.reserved.cpu = round2(r.reserved.cpu + c.cpu);
      r.reserved.memoryMb += c.memoryMb;
      byRegion.set(c.region, r);
    }
    return { regions: [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region)), note: 'Shared host VMs arrive with spec 8.2; until then instances run on the mock runtime.' };
  }

  /**
   * The platform's inventory (8.1.5): what the runtime runs with this install's labels, per workload, into the record's
   * `observed`. It never changes a label or removes anything; a workload with an operation under way is left to it.
   */
  async function inventory() {
    const installId = await config.installId();
    const busy = await operations.busy();
    for (const tenantId of await repos.tenants()) {
      for (const w of await repos.workloads.list(tenantId)) {
        if (busy.has(`workload:${tenantId}/${w.name}`)) continue;
        const mine = await runtime.list({ labels: { 'noobly-install': installId, 'noobly-tenant': tenantId, 'noobly-workload': w.name } });
        const observed = { running: mine.filter((c) => c.status === 'running').length, stopped: mine.filter((c) => c.status !== 'running').length, seenAt: iso() };
        await repos.workloads.update(tenantId, w.name, (r) => r && { ...r, observed });
      }
    }
  }

  /** Operators: every tenant and its workloads. */
  async function overview() {
    const tenants = [];
    for (const id of await repos.tenants()) {
      const list = (await repos.workloads.list(id)).sort((a, b) => a.name.localeCompare(b.name)).map(view);
      if (!list.length) continue;
      tenants.push({
        id,
        workloads: list,
        counts: Object.fromEntries(STATUSES.map((s) => [s, list.filter((w) => w.status === s).length])),
        reserved: {
          cpu: round2(list.filter((w) => w.status !== 'suspended' && w.kind !== 'job' && w.kind !== 'static').reduce((s, w) => s + w.plan.cpu * w.instances, 0)),
          memoryMb: list.filter((w) => w.status !== 'suspended' && w.kind !== 'job' && w.kind !== 'static').reduce((s, w) => s + w.plan.memoryMb * w.instances, 0),
        },
      });
    }
    return { tenants, totals: { tenants: tenants.length, workloads: tenants.reduce((s, t) => s + t.workloads.length, 0), live: tenants.reduce((s, t) => s + t.counts.live, 0) } };
  }

  return {
    /** hosted.services.platform: what a launcher calls. */
    services: {
      workloads: {
        ...workloads,
        /** Where a workload's running instances answer: [{ instance, url }] (local sites, spec 8.9 R10). */
        async endpoints(tenantId, name) {
          const w = await mustGet(tenantId, name);
          return localRuntime?.handles(w.region) ? localRuntime.endpoints(tenantId, name) : [];
        },
      },
      deploys,
      usage,
      capacity,
      /** Runtime log lines (spec 8.9 R11): the last ones kept, after a cursor. */
      logs: {
        async tail(tenantId, name, { after = 0, limit = 500 } = {}) {
          await mustGet(tenantId, name);
          const buf = logBuffers.get(`${tenantId}/${name}`) ?? { seq: 0, lines: [] };
          const lines = buf.lines.filter((l) => l.seq > after).slice(-Math.min(Math.max(1, limit), LOG_KEEP));
          return { lines, cursor: buf.seq };
        },
      },
      /** The local sites a launcher may offer as regions. */
      sites: async () => (local ? (await local.servers.sites()).map((s) => ({ id: s.id, name: s.name, mode: s.mode })) : []),
    },
    overview,
    addLocalSite,
    localRuntime,
    inventory,
    runtime,
    repos,
    /** Operations under way for a tenant (operators' screen). */
    active: async (tenantId) => (await operations.list({ tenant: tenantOf(tenantId) })).filter((op) => inProgress(op)),
  };
}
