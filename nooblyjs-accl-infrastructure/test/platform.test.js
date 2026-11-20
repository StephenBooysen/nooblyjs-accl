// The platform layer (spec 8.1): off unless a launcher asks; workloads that belong to one tenant each, reached only
// with that tenant's id; the in-process services.platform API with its error codes; workload operations with a lock per
// workload and a cap per tenant; events with tenant ids on the launcher's own EventEmitter; labels on everything made
// for a workload; the operators' read-only API and the seed tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { startApp } from './helpers.js';
import { createPlatformRepos } from '../src/platform/repos.js';

const require = createRequire(import.meta.url);
const { FsStore } = require('nooblyjs-core/src/store/fs-store.js');

const PAT = { id: 'pat', name: 'Pat', kind: 'person' };
const LEE = { id: 'lee', name: 'Lee', kind: 'person' };
const on = { platform: { enabled: true } };

/** Collects every event of the given types on an emitter. */
function collect(emitter, types) {
  const seen = [];
  for (const type of types) emitter.on(type, (payload) => seen.push({ ...payload, type }));
  return seen;
}

/** Runs `fn` and returns the error it throws (asserting it throws). */
async function refusal(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal');
}

test('8.1.1 off unless asked for: no services.platform, routes, nav row, job, operation types or records', async () => {
  const t = await startApp({ seed: true });
  try {
    assert.equal(t.hosted.services.platform, undefined);
    assert.equal(t.hosted.mockRuntime, undefined);
    assert.ok(!t.hosted.nav.some((n) => n.key === 'platform'));
    const res = await t.get('/infrastructure/api/v1/platform', { as: 'stevie' });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.message, 'No such API route.');
    await assert.rejects(t.hosted.runJob('platform-inventory'));
    await assert.rejects(fs.access(path.join(t.dataDir, 'workloads')), 'the seed wrote no workloads');
    await assert.rejects(fs.access(path.join(t.dataDir, 'mock-cloud', 'platform.yaml')));
    await assert.rejects(fs.access(path.join(t.dataDir, 'operations', 'op_seedorders.md')));
  } finally {
    await t.close();
  }
  await assert.rejects(startApp({ platform: 'yes' }).then((t) => {
    const err = t.mountError;
    return t.close().then(() => { if (err) throw err; });
  }), /options\.platform/);
});

test('8.1.2 every repo call needs a tenant, and a record filed under another tenant is not read', async () => {
  const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'platform-repos-'));
  try {
    const store = new FsStore(dir);
    const warnings = [];
    const repos = createPlatformRepos(store, { log: { warn: (m) => warnings.push(m), info() {}, error() {} } });
    const calls = {
      'workloads.list': (t) => repos.workloads.list(t),
      'workloads.get': (t) => repos.workloads.get(t, 'api'),
      'workloads.write': (t) => repos.workloads.write(t, { name: 'api' }),
      'workloads.update': (t) => repos.workloads.update(t, 'api', (w) => w),
      'workloads.remove': (t) => repos.workloads.remove(t, 'api'),
      'deploys.list': (t) => repos.deploys.list(t, 'api'),
      'deploys.get': (t) => repos.deploys.get(t, 'api', 'dep_abcd1234'),
      'deploys.write': (t) => repos.deploys.write(t, 'api', { id: 'dep_abcd1234' }),
      'deploys.update': (t) => repos.deploys.update(t, 'api', 'dep_abcd1234', (d) => d),
    };
    const methods = [...Object.keys(repos.workloads).map((m) => `workloads.${m}`), ...Object.keys(repos.deploys).map((m) => `deploys.${m}`)];
    assert.deepEqual(methods.sort(), Object.keys(calls).sort(), 'the test covers every repo method');
    for (const [name, call] of Object.entries(calls)) {
      for (const bad of [undefined, null, '', '..', '../other', 'a/b', 'x'.repeat(65), 42]) {
        await assert.rejects(call(bad), TypeError, `${name}(${JSON.stringify(bad)})`);
      }
    }

    await repos.workloads.write('acme', { name: 'api', kind: 'service' });
    assert.equal((await repos.workloads.get('acme', 'api')).tenantId, 'acme');
    assert.equal(await repos.workloads.get('globex', 'api'), null);
    // A file copied by hand into another tenant's folder still says whose it is, and is skipped.
    await fs.mkdir(path.join(dir, 'workloads', 'globex'), { recursive: true });
    await fs.copyFile(path.join(dir, 'workloads', 'acme', 'api.md'), path.join(dir, 'workloads', 'globex', 'api.md'));
    assert.equal(await repos.workloads.get('globex', 'api'), null);
    assert.deepEqual(await repos.workloads.list('globex'), []);
    assert.ok(warnings.some((w) => /says tenant acme/.test(w)));
    assert.deepEqual(await repos.tenants(), ['acme', 'globex']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('8.1.3 input is checked: invalid names each field, conflict, not_found, quota', async () => {
  process.env.INFRA_WORKLOADS_PER_TENANT = '2';
  const t = await startApp(on);
  delete process.env.INFRA_WORKLOADS_PER_TENANT;
  const p = t.hosted.services.platform;
  try {
    const named = await p.workloads.create('acme', { name: 'pinned', kind: 'worker', source: { repo: 'acme/w' } }, { actor: PAT, commit: 'abcdef0123', message: 'Ship it' });
    await t.hosted.idle();
    const pinned = (await p.deploys.list('acme', 'pinned')).deploys[0];
    assert.deepEqual([pinned.commit, pinned.message], ['abcdef0123', 'Ship it']);
    assert.equal(named.workload.name, 'pinned');
    assert.equal((await refusal(() => p.workloads.create('acme', { name: 'x', source: { repo: 'a/b' } }, { commit: 'zzz' }))).details.fields.commit, '7 to 40 hex characters.');
    await p.workloads.remove('acme', 'pinned', { actor: PAT });
    await t.hosted.idle();

    const bad = await refusal(() => p.workloads.create('acme', {
      name: 'API', kind: 'worker', source: { repo: 'acme/api', image: 'x' }, run: { port: 80, env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }, instances: 99, region: 'mars-1',
    }));
    assert.equal(bad.code, 'invalid');
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.details.fields).sort(), ['instances', 'name', 'region', 'run.env.1', 'run.port', 'source'].sort());
    assert.equal((await refusal(() => p.workloads.create('acme', { name: 'web', source: { repo: 'acme/web' }, run: { env: [{ key: 'X', value: '1', secretRef: 's' }] } }))).details.fields['run.env.0'], 'Exactly one of value, secretRef or link.');
    assert.equal((await refusal(() => p.workloads.create('', { name: 'web', source: { repo: 'acme/web' } }))).code, 'invalid', 'a tenant id is required');
    assert.equal((await refusal(() => p.workloads.create('acme', { name: 'web', source: { repo: 'acme/web' } }, { actor: 'pat' }))).details.fields.actor, 'Send { id, name, kind }.');

    await p.workloads.create('acme', { name: 'web', source: { repo: 'acme/web' }, domains: ['web.acme.example'] }, { actor: PAT });
    assert.equal((await refusal(() => p.workloads.create('acme', { name: 'web', source: { repo: 'acme/web' } }))).code, 'conflict');
    // Another tenant can use the same name, but not the same domain, and is not told whose it is.
    await p.workloads.create('globex', { name: 'web', source: { image: 'ghcr.io/globex/web:1' } }, { actor: LEE });
    const taken = await refusal(() => p.workloads.create('globex', { name: 'site', kind: 'static', source: { repo: 'globex/site' }, domains: ['web.acme.example'] }));
    assert.equal(taken.code, 'conflict');
    assert.doesNotMatch(JSON.stringify([taken.message, taken.details]), /acme\b(?!\.example)/);

    await p.workloads.create('acme', { name: 'worker', kind: 'worker', source: { repo: 'acme/web' } });
    const full = await refusal(() => p.workloads.create('acme', { name: 'third', source: { repo: 'acme/web' } }));
    assert.deepEqual([full.code, full.status], ['quota', 429]);

    assert.equal((await refusal(() => p.workloads.get('acme', 'nope'))).code, 'not_found');
    assert.equal((await refusal(() => p.workloads.update('acme', 'web', { name: 'renamed' }))).details.fields.name, 'Fixed once the workload exists.');
    assert.equal((await refusal(() => p.workloads.runJob('acme', 'web', {}))).code, 'invalid', 'only a job runs');
    assert.equal((await refusal(() => p.workloads.deploy('acme', 'web', { commit: 'not-a-sha' }))).details.fields.commit, '7 to 40 hex characters.');
    await t.hosted.idle();
  } finally {
    await t.close();
  }
});

test('exit check: two tenants create workloads on the mock cloud, deploy events reach the launcher\'s emitter, and neither reaches the other\'s', async () => {
  const eventEmitter = new EventEmitter();
  const seen = collect(eventEmitter, ['infrastructure.workload.created', 'infrastructure.deploy.started', 'infrastructure.deploy.progress', 'infrastructure.deploy.succeeded', 'infrastructure.workload.status', 'infrastructure.operation.succeeded']);
  const t = await startApp({ ...on, eventEmitter });
  const p = t.hosted.services.platform;
  try {
    const a = await p.workloads.create('acme', { name: 'api', source: { repo: 'acme/api' }, plan: { cpu: 1, memoryMb: 2048 }, instances: 2, healthCheck: { path: '/health' } }, { actor: PAT });
    const b = await p.workloads.create('globex', { name: 'api', kind: 'private', source: { repo: 'globex/api', branch: 'trunk' } }, { actor: LEE });
    for (const r of [a, b]) {
      assert.equal(r.operation.type, 'workload.create');
      assert.equal(r.workload.status, 'deploying');
    }
    await t.hosted.idle();

    for (const tenantId of ['acme', 'globex']) {
      const w = await p.workloads.get(tenantId, 'api');
      assert.equal(w.status, 'live');
      assert.equal(w.tenantId, tenantId);
      const started = seen.find((e) => e.type === 'infrastructure.deploy.started' && e.tenantId === tenantId);
      const done = seen.find((e) => e.type === 'infrastructure.deploy.succeeded' && e.tenantId === tenantId);
      assert.ok(started && done, `${tenantId}'s deploy events reached the emitter`);
      assert.equal(done.workload, 'api');
      assert.equal(done.deployId, w.current.deployId);
      assert.equal(done.commit, w.current.commit);
      assert.equal(done.status, 'live');
      assert.equal(done.system, 'infrastructure');
      assert.ok(seen.some((e) => e.type === 'infrastructure.deploy.progress' && e.tenantId === tenantId && e.step && e.of === 3));
      assert.ok(seen.some((e) => e.type === 'infrastructure.workload.created' && e.tenantId === tenantId));
      assert.ok(seen.some((e) => e.type === 'infrastructure.operation.succeeded' && e.tenantId === tenantId));
    }

    // The deploy log is the tenant's: no install labels in it (they go in the operation's log, for operators).
    const firstLog = (await p.deploys.get('acme', 'api', (await p.workloads.get('acme', 'api')).current.deployId)).log;
    assert.ok(firstLog.length > 2 && !firstLog.some((l) => /noobly-install|managed-by/.test(l.text)));

        // acme's deploy id, asked for as globex, is not found; so is everything else of acme's.
    const acmeDeploy = (await p.workloads.get('acme', 'api')).current.deployId;
    assert.equal((await refusal(() => p.deploys.get('globex', 'api', acmeDeploy))).code, 'not_found');
    assert.equal((await p.deploys.get('acme', 'api', acmeDeploy)).result, 'live');
    await p.workloads.create('acme', { name: 'only-acme', kind: 'worker', source: { repo: 'acme/w' } }, { actor: PAT });
    for (const call of [
      () => p.workloads.get('globex', 'only-acme'),
      () => p.workloads.update('globex', 'only-acme', { instances: 3 }),
      () => p.workloads.deploy('globex', 'only-acme', {}),
      () => p.workloads.scale('globex', 'only-acme', { instances: 2 }),
      () => p.workloads.restart('globex', 'only-acme'),
      () => p.workloads.suspend('globex', 'only-acme'),
      () => p.workloads.resume('globex', 'only-acme'),
      () => p.workloads.remove('globex', 'only-acme'),
      () => p.workloads.runJob('globex', 'only-acme', {}),
      () => p.deploys.list('globex', 'only-acme'),
    ]) {
      const err = await refusal(call);
      assert.equal(err.code, 'not_found');
      assert.equal(err.status, 404);
    }
    assert.deepEqual((await p.workloads.list('globex')).map((w) => w.name), ['api']);
    assert.deepEqual((await p.workloads.list('acme')).map((w) => w.name), ['api', 'only-acme']);
    await t.hosted.idle();
    assert.equal((await p.workloads.get('acme', 'only-acme')).status, 'live', 'nothing globex asked for touched it');
  } finally {
    await t.close();
  }
});

test('8.1.4 one operation at a time per workload, at most INFRA_OPS_PER_TENANT per tenant, other tenants unaffected', async () => {
  const eventEmitter = new EventEmitter();
  const running = new Map();
  const most = new Map();
  const order = [];
  eventEmitter.on('infrastructure.operation.started', (e) => {
    running.set(e.tenantId, (running.get(e.tenantId) ?? 0) + 1);
    most.set(e.tenantId, Math.max(most.get(e.tenantId) ?? 0, running.get(e.tenantId)));
    order.push(`start ${e.resource.name} ${e.type}`);
  });
  const ended = (e) => {
    running.set(e.tenantId, running.get(e.tenantId) - 1);
    order.push(`end ${e.resource.name} ${e.type}`);
  };
  eventEmitter.on('infrastructure.operation.succeeded', ended);
  eventEmitter.on('infrastructure.operation.failed', ended);
  const t = await startApp({ ...on, eventEmitter, mockStepMs: 15 });
  const p = t.hosted.services.platform;
  try {
    for (const name of ['one', 'two', 'three', 'four']) await p.workloads.create('acme', { name, kind: 'worker', source: { repo: 'acme/x' } }, { actor: PAT });
    await p.workloads.create('globex', { name: 'solo', kind: 'worker', source: { repo: 'globex/x' } }, { actor: LEE });
    // A second change to "one" waits for its create.
    await p.workloads.deploy('acme', 'one', { commit: 'abcdef1', actor: PAT });
    await t.hosted.idle();
    assert.equal(most.get('acme'), 2, 'acme never ran more than two at once');
    assert.equal(most.get('globex'), 1);
    assert.ok(order.indexOf('start solo workload.create') < order.indexOf('end two workload.create'), 'globex did not wait for acme');
    assert.ok(order.indexOf('end one workload.create') < order.indexOf('start one workload.deploy'), 'the deploy waited for the create');
    assert.equal((await p.workloads.get('acme', 'one')).current.commit, 'abcdef1');
    const ops = await t.get('/infrastructure/api/v1/operations', { as: 'stevie' });
    assert.ok(ops.json.operations.every((op) => op.type.startsWith('workload.') ? op.tenant : true));
  } finally {
    await t.close();
  }
});

test('a failed health check: a later deploy keeps the previous one serving; a first deploy fails the workload', async () => {
  const eventEmitter = new EventEmitter();
  const failed = collect(eventEmitter, ['infrastructure.deploy.failed']);
  const t = await startApp({ ...on, eventEmitter });
  const p = t.hosted.services.platform;
  const runtime = t.hosted.mockRuntime();
  try {
    await p.workloads.create('acme', { name: 'api', source: { repo: 'acme/api' } }, { actor: PAT });
    await t.hosted.idle();
    const before = (await p.workloads.get('acme', 'api')).current;

    runtime.failAt('workload.deploy.health', { message: 'GET /health answered 500.' });
    const { operation } = await p.workloads.deploy('acme', 'api', { commit: 'bad0bad', trigger: 'push', actor: PAT });
    await t.hosted.idle();
    const w = await p.workloads.get('acme', 'api');
    assert.equal(w.status, 'live');
    assert.deepEqual(w.current, before, 'still running the previous deploy');
    const { deploys } = await p.deploys.list('acme', 'api');
    assert.deepEqual(deploys.map((d) => [d.commit, d.result, d.trigger]), [['bad0bad', 'failed', 'push'], [before.commit, 'live', 'manual']]);
    const detail = await p.deploys.get('acme', 'api', deploys[0].id);
    assert.equal(detail.operation, operation.id);
    assert.ok(detail.log.some((l) => l.text === 'Failed: GET /health answered 500.'));
    assert.ok(detail.log.some((l) => l.text === `Kept ${before.commit} running`));
    assert.equal(failed.at(-1).reason, 'GET /health answered 500.');
    assert.equal(failed.at(-1).step, 'health');
    assert.ok((await runtime.list({ labels: { 'noobly-workload': 'api' } })).every((c) => c.image === before.image));

    runtime.failAt('workload.deploy.health');
    await p.workloads.create('acme', { name: 'new', source: { repo: 'acme/new' } }, { actor: PAT });
    await t.hosted.idle();
    assert.equal((await p.workloads.get('acme', 'new')).status, 'failed');
    assert.equal((await p.workloads.get('acme', 'new')).current, null);
  } finally {
    await t.close();
  }
});

test('update redeploys only when needed; scale, restart, suspend, resume, runJob and remove', async () => {
  const eventEmitter = new EventEmitter();
  const seen = collect(eventEmitter, ['infrastructure.workload.updated', 'infrastructure.workload.deleted', 'infrastructure.workload.status']);
  const t = await startApp({ ...on, eventEmitter });
  const p = t.hosted.services.platform;
  const runtime = t.hosted.mockRuntime();
  try {
    await p.workloads.create('acme', { name: 'api', source: { repo: 'acme/api' } }, { actor: PAT });
    await t.hosted.idle();

    const env = await p.workloads.update('acme', 'api', { run: { env: [{ key: 'LOG_LEVEL', value: 'debug' }] } }, { actor: PAT });
    assert.equal(env.operation.type, 'workload.deploy');
    await t.hosted.idle();
    assert.equal((await p.deploys.list('acme', 'api')).deploys[0].trigger, 'config');
    assert.equal((await p.workloads.get('acme', 'api')).run.port, 10000, 'a run change merges with what was there');

    const domains = await p.workloads.update('acme', 'api', { domains: ['api.acme.example'] }, { actor: PAT });
    assert.equal(domains.operation, null);
    assert.deepEqual(domains.workload.domains, ['api.acme.example']);
    assert.equal((await p.workloads.update('acme', 'api', { domains: ['api.acme.example'] })).operation, null, 'no change, nothing to do');

    const scaled = await p.workloads.scale('acme', 'api', { instances: 3, plan: { cpu: 2, memoryMb: 4096 } }, { actor: PAT });
    assert.equal(scaled.operation.type, 'workload.scale');
    await t.hosted.idle();
    const containers = await runtime.list({ labels: { 'noobly-tenant': 'acme', 'noobly-workload': 'api' } });
    assert.deepEqual(containers.map((c) => [c.cpu, c.memoryMb]), [[2, 4096], [2, 4096], [2, 4096]]);
    assert.equal((await p.deploys.list('acme', 'api')).deploys.length, 2, 'a scale is not a deploy');
    assert.deepEqual(seen.filter((e) => e.type === 'infrastructure.workload.updated').map((e) => e.changed), [['run'], ['domains'], ['plan', 'instances']]);

    assert.equal((await p.workloads.restart('acme', 'api', { actor: PAT })).operation.type, 'workload.restart');
    await p.workloads.suspend('acme', 'api', { actor: PAT });
    await t.hosted.idle();
    assert.equal((await p.workloads.get('acme', 'api')).status, 'suspended');
    assert.ok((await runtime.list({ labels: { 'noobly-workload': 'api' } })).every((c) => c.status === 'stopped'));
    assert.equal((await refusal(() => p.workloads.deploy('acme', 'api', {}))).code, 'conflict');
    assert.equal((await refusal(() => p.workloads.suspend('acme', 'api'))).code, 'conflict');
    await p.workloads.resume('acme', 'api', { actor: PAT });
    await t.hosted.idle();
    assert.equal((await p.workloads.get('acme', 'api')).status, 'live');
    assert.equal((await refusal(() => p.workloads.resume('acme', 'api'))).code, 'conflict');

    await p.workloads.create('acme', { name: 'etl', kind: 'job', source: { repo: 'acme/etl' }, build: { runtime: 'python312' }, run: { command: 'python etl.py' }, schedule: '0 2 * * *' }, { actor: PAT });
    await t.hosted.idle();
    assert.equal((await runtime.list({ labels: { 'noobly-workload': 'etl' } })).length, 0, 'a job runs nothing until asked');
    const job = await p.workloads.runJob('acme', 'etl', { command: 'python etl.py --full', actor: PAT });
    assert.equal(job.operation.type, 'workload.job.run');
    await t.hosted.idle();
    assert.equal((await p.workloads.get('acme', 'etl')).lastRun.result, 'succeeded');

    await p.workloads.remove('acme', 'api', { actor: PAT });
    assert.equal((await p.workloads.get('acme', 'api')).status, 'deleting');
    assert.equal((await refusal(() => p.workloads.remove('acme', 'api'))).code, 'conflict');
    await t.hosted.idle();
    assert.equal((await refusal(() => p.workloads.get('acme', 'api'))).code, 'not_found');
    assert.deepEqual(await runtime.list({ labels: { 'noobly-workload': 'api' } }), []);
    await assert.rejects(fs.access(path.join(t.dataDir, 'workloads', 'acme', 'api')), 'its deploys went with it');
    assert.ok(seen.some((e) => e.type === 'infrastructure.workload.deleted' && e.tenantId === 'acme' && e.workload === 'api'));

    const actions = t.auditLog.filter((r) => r.tenantId === 'acme').map((r) => r.action);
    for (const a of ['workload.created', 'workload.updated', 'workload.restarted', 'workload.suspended', 'workload.resumed', 'workload.job.run', 'workload.deleted']) assert.ok(actions.includes(a), a);
    assert.ok(t.auditLog.filter((r) => r.tenantId).every((r) => r.actor === 'pat'));
  } finally {
    await t.close();
  }
});

test('8.1.5 everything made for a workload carries the tenant and workload labels, and the inventory keeps them', async () => {
  const t = await startApp(on);
  const p = t.hosted.services.platform;
  const runtime = t.hosted.mockRuntime();
  try {
    await p.workloads.create('acme', { name: 'api', source: { repo: 'acme/api' }, instances: 2 }, { actor: PAT });
    await p.workloads.create('globex', { name: 'api', source: { image: 'ghcr.io/globex/api:2' } }, { actor: LEE });
    await t.hosted.idle();
    const things = [...await runtime.list(), ...await runtime.images()];
    assert.equal(things.length, 5, '3 containers and 2 images');
    for (const thing of things) {
      assert.equal(thing.labels['managed-by'], 'noobly-cloud');
      assert.match(thing.labels['noobly-install'], /^nc-/);
      assert.ok(['acme', 'globex'].includes(thing.labels['noobly-tenant']));
      assert.equal(thing.labels['noobly-workload'], 'api');
    }
    const before = JSON.stringify((await runtime.list()).map((c) => c.labels));
    await t.hosted.runJob('platform-inventory');
    assert.equal(JSON.stringify((await runtime.list()).map((c) => c.labels)), before, 'labels unchanged');
    assert.equal((await p.workloads.get('acme', 'api')).observed.running, 2);
    assert.equal((await p.workloads.get('globex', 'api')).observed.running, 1);
    // A container stopped behind Noobly Cloud's back is seen, not removed.
    await runtime.outOfBand((s) => { s.containers.find((c) => c.labels['noobly-tenant'] === 'acme').status = 'stopped'; });
    await t.hosted.runJob('platform-inventory');
    assert.deepEqual([(await p.workloads.get('acme', 'api')).observed.running, (await p.workloads.get('acme', 'api')).observed.stopped], [1, 1]);
    assert.equal((await runtime.list()).length, 3);
  } finally {
    await t.close();
  }
});

test('8.1.6 operators read every tenant over /api/v1/platform; anyone else is refused, and nothing there writes', async () => {
  const t = await startApp({ ...on, seed: true });
  try {
    const all = await t.get('/infrastructure/api/v1/platform', { as: 'stevie' });
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.tenants.map((x) => x.id), ['exclusivity-life']);
    assert.equal(all.json.totals.workloads, 6);
    assert.ok(all.json.capacity.regions.some((r) => r.region === 'af-south-1'));
    for (const who of ['naledi-k', 'priya-s', 'lerato-m']) assert.equal((await t.get('/infrastructure/api/v1/platform', { as: who })).status, 403, who);
    assert.equal((await t.get('/infrastructure/api/v1/platform')).status, 401);

    const list = await t.get('/infrastructure/api/v1/platform/tenants/exclusivity-life/workloads?kind=worker', { as: 'stevie' });
    assert.deepEqual(list.json.workloads.map((w) => w.name), ['agents', 'orders']);
    const one = await t.get('/infrastructure/api/v1/platform/tenants/exclusivity-life/workloads/api', { as: 'stevie' });
    assert.equal(one.json.current.commit, 'a1f3c9e');
    const deploys = await t.get('/infrastructure/api/v1/platform/tenants/exclusivity-life/workloads/agents/deploys?limit=1', { as: 'stevie' });
    assert.equal(deploys.json.deploys[0].result, 'failed');
    assert.ok(deploys.json.next);
    const detail = await t.get(`/infrastructure/api/v1/platform/tenants/exclusivity-life/workloads/agents/deploys/${deploys.json.deploys[0].id}`, { as: 'stevie' });
    assert.ok(detail.json.log.some((l) => /ModuleNotFoundError/.test(l.text)));
    assert.equal((await t.get('/infrastructure/api/v1/platform/tenants/nobody/workloads/api', { as: 'stevie' })).status, 404);
    assert.equal((await t.get('/infrastructure/api/v1/platform/tenants/exclusivity-life/usage', { as: 'stevie' })).json.reserved.cpuHours > 0, true);
    assert.equal((await t.post('/infrastructure/api/v1/platform/tenants/exclusivity-life/workloads', { as: 'stevie', body: { name: 'x' } })).status, 404, 'read-only in 8.1');
    assert.ok(t.hosted.nav.some((n) => n.key === 'platform' && n.path === '/platform'));
  } finally {
    await t.close();
  }
});

test('8.1.7 the seed tenant exclusivity-life runs NooblyJS Cloud\'s services, and the deploy under way finishes', async () => {
  const t = await startApp({ ...on, seed: true });
  const p = t.hosted.services.platform;
  try {
    const list = await p.workloads.list('exclusivity-life');
    assert.deepEqual(list.map((w) => [w.name, w.kind, w.status]), [
      ['agents', 'worker', 'live'], ['api', 'service', 'live'], ['etl', 'job', 'live'],
      ['orders', 'worker', 'deploying'], ['records', 'private', 'live'], ['storefront', 'static', 'live'],
    ]);
    const api = list.find((w) => w.name === 'api');
    assert.deepEqual([api.instances, api.plan, api.domains], [2, { cpu: 1, memoryMb: 2048 }, ['api-exclusivity.nooblyjs.app']]);
    assert.equal(list.find((w) => w.name === 'etl').schedule, '0 2 * * *');
    assert.equal(list.find((w) => w.name === 'etl').lastRun.result, 'succeeded');
    const agents = (await p.deploys.list('exclusivity-life', 'agents')).deploys;
    assert.deepEqual(agents.map((d) => [d.trigger, d.result]), [['manual', 'failed'], ['push', 'live']]);
    assert.equal((await t.hosted.mockRuntime().list({ labels: { 'noobly-tenant': 'exclusivity-life' } })).length, 6);

    await t.hosted.resume();
    await t.hosted.idle();
    const orders = await p.workloads.get('exclusivity-life', 'orders');
    assert.equal(orders.status, 'live');
    assert.equal(orders.current.commit, 'e5d21b0');
    assert.equal((await p.deploys.get('exclusivity-life', 'orders', 'dep_seedord02')).result, 'live');
    assert.equal((await p.deploys.get('exclusivity-life', 'orders', 'dep_seedord01')).result, 'superseded');
  } finally {
    await t.close();
  }
});
