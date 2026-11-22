// The mock workload runtime (spec 8.1, "Mock"): images and containers kept in a file,
// <dataDir>/mock-cloud/platform.yaml, so they outlive a restart like real ones. Each call takes `stepMs` (0: at once).
// Spec 8.2 replaces it with containers on shared host VMs and 8.3 with real builds; the operations call the same
// methods. Everything it makes carries the labels it is given (the install's plus noobly-tenant and noobly-workload),
// and every list filters by labels, the way the cloud providers do (architecture.md §6.2).
//
// For tests and demos it fails on purpose: failAt('workload.deploy.health') makes the next health check fail.
import crypto from 'node:crypto';
import { CloudError } from '../providers/errors.js';
import { hasLabels } from '../providers/contract.js';

const FILE = ['mock-cloud', 'platform.yaml'];
const id = (prefix) => `${prefix}-${crypto.randomBytes(3).toString('hex')}`;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  if (!ms) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
  }, { once: true });
});

/**
 * @param {object} o
 * @param {object} o.store
 * @param {number} [o.stepMs]
 * @param {() => number} [o.now]
 */
export function createMockRuntime({ store, stepMs = 1200, now = () => Date.now() }) {
  /** [{ at, message, times }]: the next `times` calls at that step fail. */
  let failures = [];
  const iso = () => new Date(now()).toISOString();

  const read = async () => {
    const saved = (await store.readYaml(FILE)) ?? {};
    return { images: saved.images ?? [], containers: saved.containers ?? [], runs: saved.runs ?? [] };
  };
  const change = (fn) => store.withLock(FILE, async () => {
    const state = await read();
    const result = await fn(state);
    await store.writeYaml(FILE, state);
    return result;
  });

  async function step(at, signal, units = 1) {
    await sleep(stepMs * units, signal);
    const i = failures.findIndex((f) => f.at === at);
    if (i < 0) return;
    const failure = failures[i];
    if (--failure.times <= 0) failures.splice(i, 1);
    throw new CloudError(failure.code ?? 'unavailable', failure.message);
  }

  const ofWorkload = (labels) => (c) => c.labels?.['noobly-tenant'] === labels['noobly-tenant'] && c.labels?.['noobly-workload'] === labels['noobly-workload'];

  return {
    name: 'mock',

    /** Builds (or takes) an image for a commit. Finds an image already built for it by its labels first. */
    async build({ labels, commit, source = {}, runtime, signal, log = async () => {} }) {
      const tag = source.image ?? `registry.mock/${labels['noobly-tenant']}/${labels['noobly-workload']}:${commit ?? 'latest'}`;
      const existing = (await read()).images.find((im) => im.tag === tag && ofWorkload(labels)(im));
      if (existing) {
        await log(`Using image ${tag}, already built`);
        return { image: tag };
      }
      if (source.image) {
        await log(`Pulling ${tag}`);
        await step('workload.deploy.build', signal);
      } else {
        await log(`Cloning ${source.repo}${source.branch ? ` (${source.branch})` : ''} at ${commit}`);
        await log(runtime === 'dockerfile' ? 'Building from the Dockerfile' : `Building with ${runtime ?? 'node22'}`);
        await step('workload.deploy.build', signal, 2);
      }
      await change((s) => {
        s.images.push({ tag, labels, commit: commit ?? null, builtAt: iso() });
      });
      await log(`Built ${tag}`);
      return { image: tag };
    },

    /** Replaces the workload's containers with `instances` new ones running `image`. Returns the new containers. */
    async rollout({ labels, image, instances, plan, region, signal, log = async () => {} }) {
      await step('workload.deploy.rollout', signal);
      const started = await change((s) => {
        const old = s.containers.filter(ofWorkload(labels));
        s.containers = s.containers.filter((c) => !ofWorkload(labels)(c));
        const fresh = Array.from({ length: instances }, () => ({
          id: id(labels['noobly-workload']), labels, image, region, cpu: plan.cpu, memoryMb: plan.memoryMb, status: 'running', startedAt: iso(),
        }));
        s.containers.push(...fresh);
        return { fresh, old: old.length };
      });
      await log(`Started ${started.fresh.length} instance${started.fresh.length === 1 ? '' : 's'} of ${image}${started.old ? `; stopped ${started.old} old` : ''}`);
      return started.fresh;
    },

    /** Asks every running instance for its health check. */
    async health({ labels, path = '/', signal, log = async () => {} }) {
      const containers = (await read()).containers.filter(ofWorkload(labels));
      await log(`Checking ${path} on ${containers.length} instance${containers.length === 1 ? '' : 's'}`);
      await step('workload.deploy.health', signal);
      await log('Healthy');
      return { healthy: containers.length };
    },

    /** Stops, starts or restarts the workload's containers (suspend, resume, restart). */
    async setStatus({ labels, action, signal }) {
      await step(`workload.${action}`, signal);
      return change((s) => {
        const mine = s.containers.filter(ofWorkload(labels));
        for (const c of mine) {
          if (action === 'stop') c.status = 'stopped';
          else {
            c.status = 'running';
            c.startedAt = iso();
          }
        }
        return mine.length;
      });
    },

    /** Removes the workload's containers and images. */
    async remove({ labels, signal }) {
      await step('workload.delete', signal);
      return change((s) => {
        const before = s.containers.length;
        s.containers = s.containers.filter((c) => !ofWorkload(labels)(c));
        s.images = s.images.filter((im) => !ofWorkload(labels)(im));
        return before - s.containers.length;
      });
    },

    /** Runs a job's container to completion. */
    async run({ labels, image, command, env = [], signal, log = async () => {} }) {
      const runId = id('run');
      await log(`Running ${command ?? 'the start command'} in ${image}`);
      await step('workload.job.run', signal);
      await change((s) => {
        s.runs.push({ id: runId, labels, image, command: command ?? null, env: env.map((e) => ({ ...e })), exitCode: 0, endedAt: iso() });
      });
      await log('Exited with code 0');
      return { runId, exitCode: 0, durationMs: stepMs, peakMemoryMb: null };
    },

    /** The containers carrying every label asked for. */
    async list({ labels = {} } = {}) {
      return (await read()).containers.filter((c) => hasLabels(c, labels));
    },
    async images({ labels = {} } = {}) {
      return (await read()).images.filter((im) => hasLabels(im, labels));
    },

    /** For tests and demos: the next `times` calls at step `at` fail with `message`. */
    failAt(at, { message = `The mock runtime failed at ${at} on purpose.`, times = 1, code = 'unavailable' } = {}) {
      failures.push({ at, message, times, code });
    },
    /** For tests: as a person in the cloud console would, change a container behind Noobly Cloud's back. */
    outOfBand: (fn) => change(fn),
    reset() {
      failures = [];
    },
  };
}
