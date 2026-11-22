// Host pools (spec 8.2) on the mock cloud, offline: an operator creates a pool; its host is a VM (hidden from the VM
// list) whose first boot installs the agent with an enrolment token and turns on user namespaces; the agent enrols (the
// in-process mock agent stands in for the machine). Two tenants' workloads share the host with their limits, each on
// its own network, and a private name answers only inside its tenant. A full region grows the pool, and past its max
// says "Region … is full". Jobs record exit code, duration and peak memory and never overlap; a crash is an event with
// its restart count; suspending frees what a workload reserved; draining moves instances off a host and deletes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const API = '/infrastructure/api/v1/platform';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const service = (name, over = {}) => ({
  name, kind: 'service', region: 'africa-south1',
  source: { repo: 'https://github.com/acme/api', branch: 'main' }, build: { runtime: 'node22', startCommand: 'npm start' },
  run: { port: 3000 }, plan: { cpu: 0.25, memoryMb: 256 }, instances: 1, healthCheck: { path: '/' }, ...over,
});

async function start() {
  const app = await startApp({ seed: true, platform: { enabled: true }, local: { drainMs: 0 }, agents: { checkMs: 0 } });
  return { app, t: app, platform: app.hosted.services.platform, pools: app.hosted.pools, runtime: app.hosted.local.runtime };
}

/** The mock Docker of a pool host. */
const dockerOf = (pools, vm) => pools.mockAgent(vm).docker;

test('8.2.1 a pool\'s host is a hidden VM that installs the agent at first boot, with user namespaces, and enrols', async () => {
  const { app, t } = await start();
  try {
    for (const who of ['priya-s', 'naledi-k']) assert.equal((await t.post(`${API}/pools`, { as: who, body: { name: 'web' } })).status, 403, who);
    let res = await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'Web!', account: 'nope', min: 3, max: 1 } });
    assert.deepEqual([res.status, Object.keys(res.json.error.details.fields).sort()], [422, ['account', 'max', 'name']]);
    res = await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 2 } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.operations.length, 1, 'min hosts are on their way');
    await app.hosted.idle();

    const pool = (await t.get(`${API}/pools/web`, { as: 'stevie' })).json;
    assert.deepEqual([pool.region, pool.machineType, pool.min, pool.max, pool.hosts.length, pool.online], ['africa-south1', 'e2-medium', 1, 2, 1, 1]);
    const [h] = pool.hosts;
    assert.deepEqual([h.vm, h.statusText, h.allocatable, h.warnings], ['web-1', 'Online', { cpu: 1.75, memoryMb: 3584 }, []], 'e2-medium less the system reserve; userns on, so no warning');
    // Hidden from the VM list, there in the records.
    assert.ok(!(await t.get('/infrastructure/api/v1/vms', { as: 'stevie' })).json.vms.some((v) => v.name === 'web-1'));
    const cloudVm = (await (await app.hosted.mockCloud('stevie-prod')).resources((r) => r.kind === 'vm' && r.name === 'web-1'))[0];
    const userData = JSON.parse(cloudVm.userData.replace('#cloud-config\n', ''));
    assert.ok(!userData.ssh_authorized_keys, 'no person\'s key on a host');
    assert.match(userData.runcmd.flat().join(' '), /agent\/install\.sh' \| bash -s -- --token 'enr_[A-Za-z0-9_-]+' --controller/);
    assert.deepEqual(JSON.parse(userData.write_files.find((f) => f.path === '/etc/docker/daemon.json').content)['userns-remap'], 'default');
    assert.ok(!userData.packages.includes('caddy'), 'a host pool VM has no Caddy (an ingress pool\'s does, 8.4)');
    // The region now runs on the pool's hosts.
    assert.ok(app.hosted.local.runtime.handles('africa-south1'));
    const cap = (await t.get(`${API}/capacity`, { as: 'stevie' })).json.regions.find((r) => r.region === 'africa-south1');
    assert.deepEqual([cap.hosts, cap.online, cap.allocatable, cap.free], [1, 1, { cpu: 1.75, memoryMb: 3584 }, { cpu: 1.75, memoryMb: 3584 }]);
    assert.equal((await t.delete(`${API}/pools/web`, { as: 'stevie' })).status, 409, 'a pool with hosts is not deleted');
  } finally {
    await app.close();
  }
});

test('8.2.3–8.2.4 two tenants share a host with their limits; each has its own network; a private name answers only inside its tenant', async () => {
  const { app, t, platform, pools } = await start();
  try {
    await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 1 } });
    await app.hosted.idle();
    await platform.workloads.create('acme', service('api', { kind: 'private' }), { actor });
    await platform.workloads.create('acme', service('web'), { actor });
    await platform.workloads.create('Globex_Corp', service('web', { plan: { cpu: 0.5, memoryMb: 512 } }), { actor });
    await app.hosted.idle();
    for (const [tenant, name] of [['acme', 'api'], ['acme', 'web'], ['Globex_Corp', 'web']]) assert.equal((await platform.workloads.get(tenant, name)).status, 'live', `${tenant}/${name}`);

    const docker = dockerOf(pools, 'web-1');
    const containers = docker.state.containers;
    assert.equal(containers.length, 3, 'all three on the one host');
    for (const c of containers) {
      assert.deepEqual([c.args.memoryMb, c.args.readOnly], [c.labels['noobly-tenant'] === 'acme' ? 256 : 512, undefined]);
      assert.match(c.args.bind, /^10\.10\.0\.\d+$/, 'published on the host\'s private address only');
    }
    const byName = (tenant, w) => containers.find((c) => c.labels['noobly-tenant'] === tenant && c.labels['noobly-workload'] === w);
    const [acmeApi, acmeWeb, globexWeb] = [byName('acme', 'api'), byName('acme', 'web'), byName('Globex_Corp', 'web')];
    assert.equal(acmeApi.args.network, acmeWeb.args.network);
    assert.notEqual(acmeApi.args.network, globexWeb.args.network);
    assert.deepEqual(acmeApi.args.aliases, ['api.acme.internal']);
    assert.deepEqual(globexWeb.args.aliases, ['web.globex-corp.internal']);
    assert.equal(docker.resolve(acmeWeb.name, 'api.acme.internal'), acmeApi.name, 'acme reaches its private service');
    assert.equal(docker.resolve(globexWeb.name, 'api.acme.internal'), null, 'another tenant cannot');
    assert.equal(platform.workloads.internalHost('acme', { kind: 'private', name: 'api' }), 'api.acme.internal');
    assert.equal(platform.workloads.internalHost('acme', { kind: 'worker', name: 'q' }), null);
  } finally {
    await app.close();
  }
});

test('8.2 R4: a full region grows its pool by a host; past its max a deploy fails with "Region … is full"', async () => {
  const { app, t, platform, runtime } = await start();
  try {
    await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'small', min: 1, max: 2 } });
    await app.hosted.idle();
    // e2-small: 1.75 vCPU and 1536 MB to place on; two 1 GB instances need two hosts, spread one each.
    await platform.workloads.create('acme', service('big', { plan: { cpu: 0.5, memoryMb: 1024 }, instances: 2 }), { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'big')).status, 'live');
    const pool = (await t.get(`${API}/pools/web`, { as: 'stevie' })).json;
    assert.deepEqual(pool.hosts.map((h) => h.vm), ['web-1', 'web-2']);
    assert.deepEqual(pool.hosts.map((h) => h.instances), [1, 1]);
    const [deploy] = (await platform.deploys.list('acme', 'big')).deploys;
    const text = (await platform.deploys.get('acme', 'big', deploy.id)).log.map((l) => l.text).join('\n');
    assert.match(text, /Region africa-south1 has no room for one more instance; adding a host/);
    assert.match(text, /Adding a host to pool web \(1 → 2 of at most 2\)/);
    assert.ok((await runtime.list()).every((i) => i.status === 'running'));

    // At its max: the next deploy that does not fit fails, and says why.
    await platform.workloads.create('acme', service('more', { plan: { cpu: 0.5, memoryMb: 1024 } }), { actor });
    await app.hosted.idle();
    const more = await platform.workloads.get('acme', 'more');
    assert.equal(more.status, 'failed');
    const failed = (await platform.deploys.list('acme', 'more')).deploys[0];
    assert.match(failed.error?.message ?? JSON.stringify(failed), /Region africa-south1 is full/);
  } finally {
    await app.close();
  }
});

test('8.2.5–8.2.6 jobs record exit code, duration and peak memory and never overlap (a second run is refused); crashes are events; suspend frees, resume re-places', async () => {
  const { app, t, platform, pools, runtime } = await start();
  const events = [];
  app.eventEmitter.on('infrastructure.instance.crashed', (e) => events.push(e));
  try {
    await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 1 } });
    await app.hosted.idle();
    // A job asked to run while it runs: the second is refused, so a schedule that fires again skips.
    const job = service('nightly', { kind: 'job', run: { command: 'node task.js' } });
    delete job.healthCheck;
    await platform.workloads.create('acme', job, { actor });
    await app.hosted.idle();
    const docker = dockerOf(pools, 'web-1');
    const release = docker.holdJobs();
    const jobEvents = [];
    for (const type of ['infrastructure.job.started', 'infrastructure.job.succeeded']) app.eventEmitter.on(type, (e) => jobEvents.push({ type, ...e }));
    await platform.workloads.runJob('acme', 'nightly', { actor, trigger: 'schedule' });
    await assert.rejects(platform.workloads.runJob('acme', 'nightly', { actor }), (e) => e.status === 409 && /already running/.test(e.message));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await app.hosted.idle();
    assert.equal(docker.peakJobs, 1, 'a job never runs twice at once');
    assert.deepEqual(jobEvents.map((e) => [e.type, e.tenantId, e.workload, e.trigger]), [['infrastructure.job.started', 'acme', 'nightly', 'schedule'], ['infrastructure.job.succeeded', 'acme', 'nightly', 'schedule']]);
    assert.deepEqual([jobEvents[1].exitCode, jobEvents[1].peakMemoryMb], [0, 32]);
    const { runs } = await platform.jobs.runs('acme', 'nightly');
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].status, runs[0].trigger, runs[0].exitCode, runs[0].peakMemoryMb, runs[0].reason], ['succeeded', 'schedule', 0, 32, null]);
    assert.equal(runs[0].id, jobEvents[0].runId);
    const one = await platform.jobs.get('acme', 'nightly', runs[0].id);
    assert.ok(one.log.some((l) => /Exited with code 0/.test(l.text)), 'the run\'s log');
    await assert.rejects(platform.jobs.get('acme', 'nightly', 'op_nope'), (e) => e.code === 'not_found');
    await assert.rejects(platform.jobs.runs('globex', 'nightly'), (e) => e.code === 'not_found', 'another tenant');
    const { lastRun } = await platform.workloads.get('acme', 'nightly');
    assert.deepEqual([lastRun.result, lastRun.exitCode, lastRun.peakMemoryMb], ['succeeded', 0, 32]);
    assert.equal(typeof lastRun.durationMs, 'number');
    assert.ok(!docker.state.containers.some((c) => c.labels['noobly-workload'] === 'nightly'), 'job containers are gone');

    // A crash: Docker restarts it and the restart count goes up; after five it gives up.
    await platform.workloads.create('acme', service('web'), { actor });
    await app.hosted.idle();
    const [inst] = (await runtime.list()).filter((i) => i.labels['noobly-workload'] === 'web');
    docker.crash(inst.name, 137);
    await runtime.statsNow(inst.server);
    assert.ok(await until(() => events.length === 1));
    assert.deepEqual([events[0].tenantId, events[0].workload, events[0].exitCode, events[0].restarts, events[0].gaveUp], ['acme', 'web', 137, 1, false]);
    for (let i = 0; i < 5; i += 1) docker.crash(inst.name, 1);
    await runtime.statsNow(inst.server);
    assert.ok(await until(() => events.some((e) => e.gaveUp)));
    assert.equal((await runtime.list()).find((i) => i.name === inst.name).status, 'crashed');
    const words = (await t.get('/infrastructure/api/v1/activity?kind=workload&limit=5', { as: 'stevie' })).json.activity.map((a) => a.text);
    assert.ok(words.some((w) => /exited with code 137; restarted \(1 of 5\)/.test(w)), words.join(' | '));

    // Suspend: the containers go and what they reserved is free; resume places them again.
    await platform.workloads.create('acme', service('shop', { plan: { cpu: 0.5, memoryMb: 1024 } }), { actor });
    await app.hosted.idle();
    const reserved = async () => (await t.get(`${API}/capacity`, { as: 'stevie' })).json.regions.find((r) => r.region === 'africa-south1').reserved.memoryMb;
    const before = await reserved();
    await platform.workloads.suspend('acme', 'shop', { actor });
    await app.hosted.idle();
    assert.equal(await reserved(), before - 1024);
    assert.ok(!docker.state.containers.some((c) => c.labels['noobly-workload'] === 'shop'));
    await platform.workloads.resume('acme', 'shop', { actor });
    await app.hosted.idle();
    assert.equal(await reserved(), before);
    assert.equal(docker.state.containers.filter((c) => c.labels['noobly-workload'] === 'shop').length, 1);
  } finally {
    await app.close();
  }
});

test('8.2 R6 a job with concurrency runs that many at once with their own variables, refuses one more, holds no deploy up, and reserves room for each', async () => {
  const { app, t, platform, pools } = await start();
  try {
    await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 1 } });
    await app.hosted.idle();
    const job = service('tasks', { kind: 'job', concurrency: 3, run: { command: 'node task.js', env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'TASK', value: 'from-the-spec' }] } });
    delete job.healthCheck;
    await platform.workloads.create('acme', job, { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'tasks')).concurrency, 3);
    await assert.rejects(platform.workloads.create('acme', service('web-c', { concurrency: 2 }), { actor }), (e) => e.code === 'invalid' && /Only a job/.test(e.details.fields.concurrency));
    await assert.rejects(platform.workloads.runJob('acme', 'tasks', { actor, env: [{ key: 'bad key', value: 'x' }] }), (e) => e.code === 'invalid' && Boolean(e.details.fields.env));
    await assert.rejects(platform.workloads.runJob('acme', 'tasks', { actor, trigger: 'cron' }), (e) => e.code === 'invalid');

    const docker = dockerOf(pools, 'web-1');
    const release = docker.holdJobs();
    // Three asks at once: each takes a lane of its own; the fourth is refused.
    const asks = await Promise.all([1, 2, 3].map((n) => platform.workloads.runJob('acme', 'tasks', { actor, trigger: 'api', env: [{ key: 'TASK', value: `send-${n}` }, { key: 'TASK_INPUT', value: JSON.stringify({ n }) }] })));
    assert.equal(new Set(asks.map((a) => a.operation.id)).size, 3);
    await assert.rejects(platform.workloads.runJob('acme', 'tasks', { actor }), (e) => e.status === 409 && /already running 3 of 3 runs at once/.test(e.message));
    assert.ok(await until(() => docker.jobs.length === 3), 'all three started without waiting for each other');

    // A deploy of the job, and of another workload of the tenant (perTenant is 2), go while the runs hold.
    await platform.workloads.create('acme', service('api'), { actor });
    await platform.workloads.deploy('acme', 'tasks', { actor });
    assert.ok(await until(async () => (await platform.workloads.get('acme', 'api')).status === 'live'), 'another workload deploys while three runs go');
    assert.ok(await until(async () => (await platform.deploys.list('acme', 'tasks')).deploys[0].result === 'live'), 'the job deploys while its runs go');
    assert.equal(docker.peakJobs, 3);

    // The capacity counts the runs: a fourth run's room is reserved while they go.
    release();
    await app.hosted.idle();
    const { runs } = await platform.jobs.runs('acme', 'tasks');
    assert.deepEqual(runs.map((r) => [r.status, r.trigger]), [['succeeded', 'api'], ['succeeded', 'api'], ['succeeded', 'api']]);
    const envOf = (j) => Object.fromEntries(j.env.map((e) => [e.key, e.value]));
    assert.deepEqual(docker.jobs.map((j) => envOf(j).TASK).sort(), ['send-1', 'send-2', 'send-3'], 'a run\'s variable wins over the spec\'s');
    assert.ok(docker.jobs.every((j) => envOf(j).LOG_LEVEL === 'info' && JSON.parse(envOf(j).TASK_INPUT).n >= 1), 'the spec\'s others are kept');
    assert.ok(docker.jobs.every((j) => j.env.filter((e) => e.key === 'TASK').length === 1), 'no key twice');

    // Room: with a plan that fits twice on the host, the third run at once finds no room.
    const free = (await t.get(`${API}/capacity`, { as: 'stevie' })).json.regions.find((r) => r.region === 'africa-south1').free;
    const big = service('big', { kind: 'job', concurrency: 3, plan: { cpu: 0.25, memoryMb: Math.floor(free.memoryMb / 2 / 64) * 64 }, run: { command: 'node big.js' } });
    delete big.healthCheck;
    await platform.workloads.create('acme', big, { actor });
    await app.hosted.idle();
    const hold = docker.holdJobs();
    for (let i = 0; i < 3; i += 1) await platform.workloads.runJob('acme', 'big', { actor });
    assert.ok(await until(async () => (await platform.jobs.runs('acme', 'big')).runs.some((r) => r.status === 'failed')));
    hold();
    await app.hosted.idle();
    const bigRuns = (await platform.jobs.runs('acme', 'big')).runs;
    assert.deepEqual(bigRuns.map((r) => r.status).sort(), ['failed', 'succeeded', 'succeeded']);
    assert.match(bigRuns.find((r) => r.status === 'failed').reason, /full|no room/i);
  } finally {
    await app.close();
  }
});

test('8.2.7 draining a host moves its instances one at a time to another, then deletes it', async () => {
  const { app, t, platform, pools, runtime } = await start();
  try {
    await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 2 } });
    await app.hosted.idle();
    await platform.workloads.create('acme', service('web', { instances: 2 }), { actor });
    await app.hosted.idle();
    const web1 = (await t.get(`${API}/pools/web`, { as: 'stevie' })).json.hosts[0].server;
    assert.ok((await runtime.list()).every((i) => i.server === web1), 'both on web-1, the only host');
    assert.equal((await t.post(`${API}/pools/web/hosts`, { as: 'stevie' })).status, 202);
    await app.hosted.idle();
    assert.equal((await t.post(`${API}/pools/web/hosts`, { as: 'stevie' })).status, 409, 'at its max');

    const res = await t.post(`${API}/hosts/web-1/drain`, { as: 'stevie' });
    assert.equal(res.status, 202, res.text);
    await app.hosted.idle();
    const pool = (await t.get(`${API}/pools/web`, { as: 'stevie' })).json;
    assert.deepEqual(pool.hosts.map((h) => h.vm), ['web-2']);
    const web2 = pool.hosts[0].server;
    assert.ok((await runtime.list()).every((i) => i.server === web2 && i.status === 'running'), 'both instances now on web-2');
    assert.equal((await platform.workloads.get('acme', 'web')).status, 'live');
    assert.equal(pools.mockAgent('web-1'), null);
    assert.equal((await t.get('/infrastructure/api/v1/vms/web-1', { as: 'stevie' })).status, 404, 'the machine is deleted');
    const drained = (await t.get('/infrastructure/api/v1/activity?kind=pool&limit=5', { as: 'stevie' })).json.activity.find((a) => a.verb === 'Drained');
    assert.equal(drained.text, 'host web-1 of pool web (2 instances moved)');
  } finally {
    await app.close();
  }
});
