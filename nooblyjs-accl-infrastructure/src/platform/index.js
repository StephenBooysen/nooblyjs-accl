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
import { checkSpec, specOf, same, isEnvKey, CHANGEABLE, REDEPLOY, RESCALE } from './spec.js';
import { isTenantId, isWorkloadName, KINDS, STATUSES, HTTP_KINDS, internalHost } from './names.js';
import { CloudError } from '../providers/errors.js';

export const OPERATION_TYPES = ['workload.create', 'workload.deploy', 'workload.scale', 'workload.restart', 'workload.suspend', 'workload.resume', 'workload.sleep', 'workload.wake', 'workload.delete', 'workload.job.run'];
export const TRIGGERS = ['push', 'manual', 'config'];
/** What may start a job's run: a person, the launcher's schedule, or the launcher's API (a task queue, 8.2 R6). */
export const RUN_TRIGGERS = ['manual', 'schedule', 'api'];
/** A run's own variables (runJob's env): how many, and how much text in all. */
const RUN_ENV = { count: 20, bytes: 65_536 };
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
  // Telemetry (spec 8.5 R1, R3, R4; delivered for local sites by 8.9.9): subscribers and events get every log line and
  // every 10 s sample as it arrives; the accelerator keeps only short buffers (the log lines above, 15 minutes of
  // samples per instance).
  const subscribers = new Set();
  const SAMPLE_KEEP_MS = 15 * 60_000;
  const sampleBuffers = new Map(); // `${tenant}/${workload}` → Map(instance → samples[])
  const raw = (type, payload) => {
    try {
      emitRaw(type, payload);
    } catch (err) {
      log.warn(`an ${type} listener failed: ${err.message}`);
    }
  };
  const tell = (kind, payload) => {
    for (const s of subscribers) {
      if (s.tenantId && s.tenantId !== payload.tenantId) continue;
      try {
        s[kind]?.(payload);
      } catch (err) {
        log.warn(`a telemetry subscriber failed: ${err.message}`);
      }
    }
  };
  function onLog(tenantId, workload, lines) {
    const key = `${tenantId}/${workload}`;
    const buf = logBuffers.get(key) ?? { seq: 0, lines: [] };
    const added = lines.map((l) => ({ seq: (buf.seq += 1), at: l.at, out: l.out, line: l.line, instance: l.instance ?? null }));
    buf.lines.push(...added);
    if (buf.lines.length > LOG_KEEP) buf.lines.splice(0, buf.lines.length - LOG_KEEP);
    logBuffers.set(key, buf);
    raw('infrastructure.workload.log', { tenantId, workload, lines: added });
    // 8.5 R3's shape: { tenantId, workload, instance, at, stream, line }.
    const tagged = added.map((l) => ({ tenantId, workload, instance: l.instance, at: l.at, stream: l.out, line: l.line, seq: l.seq }));
    raw('infrastructure.telemetry.logs', { tenantId, workload, lines: tagged });
    tell('onLogs', { tenantId, workload, lines: tagged });
  }
  function onMetrics(tenantId, workload, sample) {
    const key = `${tenantId}/${workload}`;
    const byInstance = sampleBuffers.get(key) ?? new Map();
    const list = byInstance.get(sample.instance) ?? [];
    list.push(sample);
    const cutoff = now() - SAMPLE_KEEP_MS;
    while (list.length && Date.parse(list[0].at) < cutoff) list.shift();
    byInstance.set(sample.instance, list);
    // Instances that have sent nothing for the whole window are gone.
    for (const [name, l] of byInstance) if (!l.length || Date.parse(l.at(-1).at) < cutoff) byInstance.delete(name);
    sampleBuffers.set(key, byInstance);
    const payload = { tenantId, workload, samples: [sample] };
    raw('infrastructure.telemetry.metrics', payload);
    tell('onMetrics', payload);
  }

  // Local sites are regions too (spec 8.9 R1); their workloads run on the local runtime, everything else on the mock.
  // An instance on a lost server went unknown, came back, moved, or could not move (spec 8.9 R7). Activity, which the
  // launcher's EventEmitter also hears.
  function onInstances(c) {
    emit('infrastructure.workload.instances', c).catch((err) => log.warn(`instances event: ${err.message}`));
  }
  // A container exited and Docker restarted it, or gave up after five tries (spec 8.2 R7): Activity.
  function onCrash(tenantId, workload, c) {
    emit('infrastructure.instance.crashed', { tenantId, workload, ...c }).catch((err) => log.warn(`crash event: ${err.message}`));
  }
  const localRuntime = local ? createLocalRuntime({
    store, servers: local.servers, hub: local.hub, resolveSecrets, onLog, onInstances, onMetrics, onCrash, now, log,
    // Raw, not Activity: a launcher's proxy re-reads workloads.endpoints() when it hears this.
    onEndpoints: (tenantId, workload) => raw('infrastructure.workload.endpoints', { tenantId, workload }),
    statsEveryS: local.statsEveryS ?? 10, drainMs: local.drainMs ?? 2000, poolDrainMs: local.poolDrainMs ?? local.drainMs ?? 30_000,
  }) : null;
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
  /** Registers a local site as a region (or a cloud region with host pools, spec 8.2). */
  function addLocalSite(id) {
    if (!localRuntime) return;
    localRuntime.addSite(id);
    regions.add(id);
  }
  /** A cloud region whose last host pool went: back to the mock runtime (it stays a region: it is in the catalog). */
  function removeLocalSite(id) {
    localRuntime?.removeSite(id);
  }

  /** The private names a workload answers to on its tenant's network (spec 8.2 R5): services and private services. */
  const aliasesOf = (tenantId, w) => (HTTP_KINDS.has(w.kind) ? [internalHost(tenantId, w.name)] : []);

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
    const after = await repos.workloads.update(tenantId, name, (w) => w && { ...w, ...patch, status, ...(w.status !== status ? { statusAt: iso() } : {}) });
    if (after && before?.status !== status) {
      await emit('infrastructure.workload.status', { tenantId, workload: name, status, was: before?.status ?? null });
      notifyChanged(tenantId, name);
    }
    return after;
  }
  /** Someone who serves the workload (a region's ingress, spec 8.4) wants to hear when its status or domains change. */
  let onChanged = () => {};
  let trafficOf = null;
  let hostsOf = null;
  const notifyChanged = (tenantId, name) => {
    try { Promise.resolve(onChanged(tenantId, name)).catch((err) => log.warn(`after ${tenantId}/${name} changed: ${err.message}`)); } catch (err) { log.warn(err.message); }
  };

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
        const buildEnv = (w.run?.env ?? []).filter((e) => e.build === true);
        const built = await runtime.build({ labels: await labelsOf(ctx), commit, source: w.source ?? {}, runtime: w.build?.runtime, build: w.build ?? {}, buildEnv, region: w.region, deployId, signal: ctx.signal, log });
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
        await runtime.rollout({ labels: await labelsOf(ctx), image: ctx.state.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, aliases: aliasesOf(ctx.op.tenant, w), signal: ctx.signal, log });
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

  /**
   * A scale that failed removed only what it had started, so what runs is what ran before: the record says so again
   * (unless it has been changed since), and the launcher hears why.
   */
  async function scaleFailed(ctx, err) {
    const tenantId = ctx.op.tenant;
    const name = ctx.op.resource.name;
    const { instances, plan, from } = ctx.input ?? {};
    const reason = ctx.op.error?.message ?? (isCloudError(err) ? err.message : 'Something went wrong. It has been logged.');
    if (!from) return;
    let reverted = false;
    await repos.workloads.update(tenantId, name, (r) => {
      if (!r || r.instances !== instances || !same(r.plan, plan)) return r;
      reverted = true;
      return { ...r, instances: from.instances, plan: from.plan };
    });
    await emit('infrastructure.workload.scale_failed', { tenantId, workload: name, reason, reverted, instances: from.instances, plan: from.plan }, ctx.op.requestedBy);
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
        if (!localRuntime?.handles(w.region)) await runtime.rollout({ labels: await labelsFor(tenantId, name), image: w.current.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, aliases: aliasesOf(tenantId, w), log: deployLog(tenantId, name, deployId) });
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
        label: 'Apply the new count or size',
        async run(ctx) {
          const w = await workloadOf(ctx);
          await runtime.rollout({ labels: await labelsOf(ctx), image: w.current.image, instances: w.instances, plan: w.plan, region: w.region, run: w.run, healthCheck: w.healthCheck, aliases: aliasesOf(ctx.op.tenant, w), resize: true, signal: ctx.signal, log: ctx.log });
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
    failed: scaleFailed,
  });
  const simple = (type, verb, label, key, stepLabel, action, after) => operations.define(type, {
    label: (op) => `${label} ${name_(op)}`,
    verb,
    steps: [{
      key,
      label: stepLabel,
      async run(ctx) {
        const w = await workloadOf(ctx);
        await runtime.setStatus({ labels: await labelsOf(ctx), action, region: w?.region, run: w?.run, plan: w?.plan, aliases: w ? aliasesOf(ctx.op.tenant, w) : [], signal: ctx.signal });
        return {};
      },
    }],
    succeeded: after,
  });
  simple('workload.restart', 'Restarting', 'Restart', 'restart', 'Restart the instances', 'restart');
  simple('workload.suspend', 'Suspending', 'Suspend', 'stop', 'Stop the instances', 'stop', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'suspended'));
  simple('workload.resume', 'Resuming', 'Resume', 'start', 'Start the instances', 'start', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'live'));
  // Idle sleep (spec 8.4.8): like suspend and resume, started by the idle job and the wake hook rather than a person.
  simple('workload.sleep', 'Going to sleep', 'Sleep', 'stop', 'Stop the instances', 'stop', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'sleeping'));
  simple('workload.wake', 'Waking', 'Wake', 'start', 'Start the instances', 'start', (ctx) => setStatus(ctx.op.tenant, ctx.op.resource.name, 'live'));
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
  const runFacts = (ctx) => ({ tenantId: ctx.op.tenant, workload: ctx.op.resource.name, runId: ctx.op.id, trigger: ctx.input?.trigger ?? 'manual' });
  operations.define('workload.job.run', {
    label: (op) => `Run ${name_(op)}`,
    verb: 'Running',
    steps: [{
      key: 'run',
      label: 'Run the job',
      async run(ctx) {
        const w = await workloadOf(ctx);
        if (!w?.current?.image) throw new CloudError('invalid', `${ctx.op.resource.name} has nothing to run.`);
        await emit('infrastructure.job.started', runFacts(ctx), ctx.op.requestedBy);
        // Each run holds a lane of its own (runJob picks it), so runs go side by side up to the job's concurrency and
        // neither wait for a deploy nor hold one up: a run starts the image that is live when it starts.
        const result = await runtime.run({ labels: await labelsOf(ctx), image: w.current.image, command: ctx.input.command ?? w.run?.command ?? null, env: ctx.input.env ?? [], region: w.region, plan: w.plan, run: w.run, signal: ctx.signal, log: ctx.log });
        const kept = { exitCode: result.exitCode, durationMs: result.durationMs ?? null, peakMemoryMb: result.peakMemoryMb ?? null };
        if (result.exitCode !== 0) {
          await ctx.save(kept);
          throw new CloudError('invalid', `The job exited with code ${result.exitCode}.`);
        }
        return { state: kept };
      },
    }],
    async succeeded(ctx) {
      const kept = { exitCode: ctx.state.exitCode ?? 0, durationMs: ctx.state.durationMs ?? null, peakMemoryMb: ctx.state.peakMemoryMb ?? null };
      await repos.workloads.update(ctx.op.tenant, ctx.op.resource.name, (w) => w && { ...w, lastRun: { operation: ctx.op.id, result: 'succeeded', ...kept, at: iso() } });
      await emit('infrastructure.job.succeeded', { ...runFacts(ctx), ...kept }, ctx.op.requestedBy);
    },
    async failed(ctx, err) {
      const kept = { exitCode: ctx.state?.exitCode ?? null, durationMs: ctx.state?.durationMs ?? null, peakMemoryMb: ctx.state?.peakMemoryMb ?? null };
      const reason = ctx.op.error?.message ?? (isCloudError(err) ? err.message : 'Something went wrong. It has been logged.');
      await repos.workloads.update(ctx.op.tenant, ctx.op.resource.name, (w) => w && { ...w, lastRun: { operation: ctx.op.id, result: 'failed', ...kept, at: iso() } });
      await emit('infrastructure.job.failed', { ...runFacts(ctx), ...kept, reason }, ctx.op.requestedBy);
    },
  });

  // ---------------------------------------------------------------- helpers for the API

  function runView(o) {
    return {
      id: o.id, status: o.status, trigger: o.input.trigger ?? 'manual', command: o.input.command ?? null, requestedBy: o.requestedBy ?? null,
      createdAt: o.createdAt, startedAt: o.startedAt, finishedAt: o.finishedAt,
      exitCode: o.state.exitCode ?? null, durationMs: o.state.durationMs ?? null, peakMemoryMb: o.state.peakMemoryMb ?? null,
      reason: o.status === 'failed' ? (o.error?.message ?? null) : null,
    };
  }

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
    if (rest.kind === 'job') rest.concurrency ??= 1;
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

  /** A run's own variables: [{ key, value }] with plain text values, up to RUN_ENV. → a copy */
  function checkRunEnv(env) {
    const bad = (message) => unprocessable(message, { fields: { env: message } });
    if (!Array.isArray(env) || env.length > RUN_ENV.count) throw bad(`A list of up to ${RUN_ENV.count} variables.`);
    const seen = new Set();
    let bytes = 0;
    for (const e of env) {
      if (!e || typeof e !== 'object' || !isEnvKey(e.key)) throw bad('A key of letters, digits and underscores.');
      if (typeof e.value !== 'string') throw bad(`${e.key}: a value is text.`);
      if (seen.has(e.key)) throw bad(`${e.key} is set twice.`);
      seen.add(e.key);
      bytes += Buffer.byteLength(e.key) + Buffer.byteLength(e.value);
    }
    if (bytes > RUN_ENV.bytes) throw bad(`Up to ${RUN_ENV.bytes / 1024} KB in all.`);
    return env.map((e) => ({ key: e.key, value: e.value }));
  }

  /** Runs fn after any earlier call for the same key has finished (runJob's lane choice). */
  const runLocks = new Map();
  function runLock(key, fn) {
    const next = (runLocks.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => {});
    runLocks.set(key, settled);
    settled.then(() => { if (runLocks.get(key) === settled) runLocks.delete(key); });
    return next;
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
      if (changed.includes('domains')) notifyChanged(tenantId, name);

      let operation = null;
      if (changed.some((k) => REDEPLOY.includes(k)) && w.status !== 'suspended') {
        await setStatus(tenantId, name, 'deploying');
        ({ operation } = await startDeploy('workload.deploy', tenantId, updated, { trigger: 'config', actor: by, message: `Changed ${changed.join(', ')}` }));
      } else if (changed.some((k) => RESCALE.includes(k)) && w.current?.image && w.status !== 'suspended' && w.kind !== 'job') {
        operation = await operations.start('workload.scale', { resource: resourceOf(tenantId, name), tenant: tenantId, input: { instances: checked.instances, plan: checked.plan, from: { instances: w.instances, plan: w.plan } }, person: by });
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

    /**
     * Changes the instance count or plan, no rebuild. A count alone adds or removes instances and leaves the others
     * serving; a new plan starts every instance again at the new size, one set answering before the old one leaves.
     * → { workload, operation }
     */
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

    /** Idle sleep (spec 8.4.8): stops a live web service's instances; the next request through the ingress wakes it. */
    async sleep(tenantId, name, { actor, reason = 'idle' } = {}) {
      const w = await mustGet(tenantId, name);
      if (w.kind !== 'service' || w.status !== 'live') throw new HttpError(409, 'conflict', `${name} is not a live web service.`);
      const operation = await operations.start('workload.sleep', { resource: resourceOf(tenantId, name), tenant: tenantId, input: { reason }, person: actor ? actorOf(actor) : null });
      return { workload: view(w), operation };
    },

    /** Wakes a sleeping service; with waitMs, resolves true once it is live again (false if it is not yet). */
    async wake(tenantId, name, { actor, waitMs = 0 } = {}) {
      const w = await mustGet(tenantId, name);
      if (w.status === 'live') return true;
      if (w.status !== 'sleeping') return false;
      let op = (await operations.list({ resource: `workload:${tenantId}/${name}`, status: 'active' })).find((o) => o.type === 'workload.wake');
      op ??= await operations.start('workload.wake', { resource: resourceOf(tenantId, name), tenant: tenantId, person: actor ? actorOf(actor) : null });
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        if ((await repos.workloads.get(tenantId, name))?.status === 'live') return true;
        const now_ = await operations.get(op.id);
        if (['failed', 'cancelled'].includes(now_?.status)) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await repos.workloads.get(tenantId, name))?.status === 'live';
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

    /**
     * Runs a job once (the launcher keeps any schedule or queue). Up to the job's `concurrency` runs go at once (1
     * unless the spec says more); past that another is refused (409, "… is already running …"), so a schedule that
     * fires again skips rather than piling up, and a launcher's queue holds the rest. Each run holds a lane of its own:
     * it starts the image live when it starts, and a deploy neither waits for it nor makes it wait.
     * trigger: manual, schedule or api. env: the run's own plain variables ([{ key, value }], after the workload's, so
     * they win), such as a task's name and input. → { workload, operation }
     */
    async runJob(tenantId, name, { command, env = [], actor, trigger = 'manual' } = {}) {
      const by = actorOf(actor);
      if (command !== undefined && command !== null && (typeof command !== 'string' || command.length > 500)) throw unprocessable('command is up to 500 characters.', { fields: { command: 'Up to 500 characters.' } });
      if (!RUN_TRIGGERS.includes(trigger)) throw unprocessable(`trigger is one of ${RUN_TRIGGERS.join(', ')}.`, { fields: { trigger: RUN_TRIGGERS.join(', ') } });
      const runEnv = checkRunEnv(env);
      // One decision at a time per job, so two asks at once cannot both take the last free lane.
      return runLock(`${tenantId}/${name}`, async () => {
        const w = await mustGet(tenantId, name);
        if (w.kind !== 'job') throw unprocessable(`${name} is a ${w.kind}, not a job.`, { fields: { name: 'Not a job.' } });
        refuseWhile(w, ['deleting', 'suspended'], `${name} is ${w.status}.`);
        if (!w.current?.image) throw new HttpError(409, 'conflict', `${name} has no image yet. Wait for its first deploy.`);
        const limit = w.concurrency ?? 1;
        const going = (await operations.list({ resource: `workload:${tenantId}/${name}`, status: 'active' })).filter((o) => o.type === 'workload.job.run');
        if (going.length >= limit) {
          const first = going.at(-1);
          throw new HttpError(409, 'conflict', limit === 1
            ? `${name} is already running (since ${first.startedAt ?? first.createdAt}).`
            : `${name} is already running ${going.length} of ${limit} runs at once.`);
        }
        const held = new Set(going.map((o) => o.lane).filter(Boolean));
        const lane = Array.from({ length: limit }, (_, i) => `run-${i + 1}`).find((l) => !held.has(l));
        await audit(by, 'workload.job.run', tenantId, name, { trigger });
        const operation = await operations.start('workload.job.run', { resource: resourceOf(tenantId, name), lane, tenant: tenantId, input: { command: command ?? null, trigger, ...(runEnv.length ? { env: runEnv } : {}) }, person: by });
        return { workload: view(w), operation };
      });
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

  /** Per region: its hosts (spec 8.2), what they can hold, and what the running instances reserve. Operators only. */
  async function capacity() {
    const containers = await runtime.list({ labels: { 'noobly-install': await config.installId() } });
    const byRegion = new Map();
    const regionOf = (id) => {
      if (!byRegion.has(id)) byRegion.set(id, { region: id, hosts: 0, online: 0, instances: 0, reserved: { cpu: 0, memoryMb: 0 }, allocatable: null, free: null });
      return byRegion.get(id);
    };
    for (const c of containers.filter((x) => x.status === 'running' || x.status === 'starting')) {
      const r = regionOf(c.region);
      r.instances += 1;
      r.reserved.cpu = round2(r.reserved.cpu + c.cpu);
      r.reserved.memoryMb += c.memoryMb;
    }
    // A region with host pools: its hosts' allocatable, and what is free of it.
    for (const site of (local ? await local.servers.sites() : []).filter((s) => s.mode === 'pool' && (s.purpose ?? 'host') === 'host')) {
      const r = regionOf(site.region);
      const hosts = await local.servers.servers({ site: site.id });
      r.hosts += hosts.length;
      r.online += hosts.filter((h) => local.hub.isOnline(h.id)).length;
      r.allocatable ??= { cpu: 0, memoryMb: 0 };
      for (const h of hosts.filter((x) => local.hub.isOnline(x.id) && !x.draining)) {
        r.allocatable.cpu = round2(r.allocatable.cpu + (h.allocatable?.cpu ?? 0));
        r.allocatable.memoryMb += h.allocatable?.memoryMb ?? 0;
      }
    }
    for (const r of byRegion.values()) if (r.allocatable) r.free = { cpu: round2(r.allocatable.cpu - r.reserved.cpu), memoryMb: r.allocatable.memoryMb - r.reserved.memoryMb };
    return { regions: [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region)), note: 'A region with a host pool runs its instances on the pool\'s VMs; other cloud regions run on the mock runtime.' };
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
        // `unknown`: on a local server that is offline (spec 8.9 R7), neither serving nor known to be stopped.
        const unknown = mine.filter((c) => c.status === 'unknown').length;
        const observed = { running: mine.filter((c) => c.status === 'running').length, stopped: mine.filter((c) => c.status !== 'running' && c.status !== 'unknown').length, ...(unknown ? { unknown } : {}), seenAt: iso() };
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
        /**
         * A workload's instances (spec 8.5; a launcher's instance tiles): [{ instance, server, status, startedAt,
         * restarts, lastExitCode, plan: { cpu, memoryMb } }], oldest first. status: starting, running, crashed,
         * stopped or unknown (its server is offline, spec 8.9 R7).
         */
        async instances(tenantId, name) {
          const w = await mustGet(tenantId, name);
          const labels = { 'noobly-install': await config.installId(), 'noobly-tenant': tenantId, 'noobly-workload': w.name };
          return (await runtime.list({ labels }))
            .map((c) => ({
              instance: c.name ?? c.id, server: c.server ?? null, status: c.status ?? 'unknown', startedAt: c.startedAt ?? null,
              restarts: c.restarts ?? 0, lastExitCode: c.lastExitCode ?? null, plan: { cpu: c.cpu ?? w.plan.cpu, memoryMb: c.memoryMb ?? w.plan.memoryMb },
            }))
            .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.instance.localeCompare(b.instance));
        },
        /** A workload's private name for its tenant's other workloads (spec 8.2 R5), or null for kinds without a port. */
        internalHost: (tenantId, w) => (HTTP_KINDS.has(w?.kind) ? internalHost(tenantId, w.name) : null),
        /** Requests, bytes out and 5xx through the ingress over the last `hours` (spec 8.4 R7), and the last request. */
        async traffic(tenantId, name, { hours = 24 } = {}) {
          await mustGet(tenantId, name);
          return trafficOf ? trafficOf(tenantId, name, { hours }) : { requests: 0, bytesOut: 0, errors: 0, lastRequestAt: null, hours };
        },
        /** The host names a web service answers on through its region's ingress (spec 8.4 R2). */
        async hosts(tenantId, name) {
          const w = await mustGet(tenantId, name);
          return hostsOf ? hostsOf(tenantId, w) : { platform: [], custom: [] };
        },
      },
      deploys,
      /**
       * A job's runs (spec 8.2 R6), newest first: runs(tenantId, name, { limit }) → { runs }; get(tenantId, name, runId)
       * → the run with its log. A run: { id, status (queued, running, succeeded, failed, cancelled), trigger, command,
       * requestedBy, createdAt, startedAt, finishedAt, exitCode, durationMs, peakMemoryMb, reason }.
       */
      jobs: {
        async runs(tenantId, name, { limit = 20 } = {}) {
          const w = await mustGet(tenantId, name);
          if (w.kind !== 'job') throw unprocessable(`${name} is a ${w.kind}, not a job.`, { fields: { name: 'Not a job.' } });
          const list = await operations.history({ resource: `workload:${tenantId}/${name}`, type: 'workload.job.run', limit: Math.min(100, Math.max(1, Number(limit) || 20)) });
          return { runs: list.map(runView) };
        },
        async get(tenantId, name, runId) {
          await mustGet(tenantId, name);
          const [found] = (await operations.history({ resource: `workload:${tenantId}/${name}`, type: 'workload.job.run', limit: 10_000 })).filter((o) => o.id === runId);
          if (!found) throw notFound(`No run ${runId}.`);
          const { log: lines } = await operations.get(runId);
          return { ...runView(found), log: lines };
        },
      },
      usage,
      capacity,
      /**
       * Telemetry (spec 8.5 R4): subscribe({ onMetrics, onLogs, tenantId? }) → unsubscribe(). onLogs({ tenantId,
       * workload, lines }) and onMetrics({ tenantId, workload, samples }) as they arrive; `tenantId` narrows to one
       * tenant. metrics() reads the last 15 minutes kept per instance.
       */
      telemetry: {
        subscribe({ onMetrics: m, onLogs: l, tenantId } = {}) {
          const sub = { onMetrics: m, onLogs: l, tenantId: tenantId ?? null };
          subscribers.add(sub);
          return () => subscribers.delete(sub);
        },
        async metrics(tenantId, name, { since } = {}) {
          await mustGet(tenantId, name);
          const from = since ? Date.parse(since) : 0;
          const byInstance = sampleBuffers.get(`${tenantId}/${name}`) ?? new Map();
          return {
            instances: [...byInstance].map(([instance, list]) => ({ instance, samples: list.filter((x) => Date.parse(x.at) > from) })),
            keptMinutes: SAMPLE_KEEP_MS / 60_000,
          };
        },
      },
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
      sites: async () => (local ? (await local.servers.sites()).filter((s) => s.mode !== 'pool').map((s) => ({ id: s.id, name: s.name, mode: s.mode })) : []),
    },
    overview,
    /** Called with (tenantId, name) after a workload's status changes or a change lands (ingress, spec 8.4). */
    setOnChanged: (fn) => { onChanged = fn; },
    /** The ingress's traffic and host names, for services.workloads.traffic() and hosts(). */
    setIngress: (i) => { trafficOf = i.traffic; hostsOf = i.hostsOf; },
    /** The idle job (spec 8.4.8): web services with sleep set and no request for afterMin minutes go to sleep. */
    /**
     * Idle sleep (spec 8.4.8): live web services with `sleep` and no request for that long. `canWake(region)` says
     * whether something there can hold the next request and wake it (a region's ingress); elsewhere nothing sleeps.
     */
    async sleepIdle(lastRequestAt, { at = now(), canWake = async () => true } = {}) {
      let slept = 0;
      for (const tenantId of await repos.tenants()) {
        for (const w of await repos.workloads.list(tenantId)) {
          if (w.kind !== 'service' || w.status !== 'live' || !w.sleep?.afterMin) continue;
          if (!(await canWake(w.region))) continue;
          if ((await operations.list({ resource: `workload:${tenantId}/${w.name}`, status: 'active' })).length) continue;
          const last = Math.max(Date.parse(await lastRequestAt(tenantId, w.name) ?? 0) || 0, Date.parse(w.statusAt ?? w.createdAt ?? 0) || 0);
          if (at - last < w.sleep.afterMin * 60_000) continue;
          await workloads.sleep(tenantId, w.name, { reason: 'idle' });
          slept += 1;
        }
      }
      return { slept };
    },
    /** Every tenant's workloads, of one region or all: [{ tenantId, w }] (ingress, spec 8.4). */
    async allWorkloads(region) {
      const out = [];
      for (const tenantId of await repos.tenants()) {
        for (const w of await repos.workloads.list(tenantId)) if (!region || w.region === region) out.push({ tenantId, w });
      }
      return out;
    },
    addLocalSite,
    removeLocalSite,
    localRuntime,
    inventory,
    runtime,
    repos,
    /** Operations under way for a tenant (operators' screen). */
    active: async (tenantId) => (await operations.list({ tenant: tenantOf(tenantId) })).filter((op) => inProgress(op)),
  };
}
