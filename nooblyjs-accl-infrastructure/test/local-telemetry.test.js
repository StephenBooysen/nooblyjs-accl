// Spec 8.9 tasks 8.9.9 and 8.9.4, offline with the in-process agents: runtime log lines and 10 s Docker stats reach
// services.platform.telemetry.subscribe() and the infrastructure.telemetry.* events (8.5 R1, R3, R4); a server that
// drops and comes back resumes its logs with no line lost and none twice (8.5 R5), and its samples show a gap; the
// `local` provider puts a site behind the provider contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { startMockAgent } from '../agent/mock.js';
import { missingMethods } from '../src/providers/contract.js';
import { createProviders } from '../src/providers/index.js';

const TENANT = 'acme';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const spec = (over = {}) => ({
  name: 'hello', kind: 'service', region: 'lan-dev',
  source: { repo: 'https://github.com/render-examples/express-hello-world', branch: 'main' },
  build: { runtime: 'node22', startCommand: 'npm start' },
  run: { port: 10400, env: [] }, plan: { cpu: 0.5, memoryMb: 512 }, instances: 1, healthCheck: { path: '/' }, ...over,
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

async function start(local = {}) {
  const app = await startApp({
    platform: { enabled: true, resolveSecrets: async () => ({}) },
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock', statsEveryS: 5, ...local },
    agents: { checkMs: 0 },
  });
  await app.hosted.local.agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.servers())[0]?.status === 'online'));
  return { app, platform: app.hosted.services.platform };
}

/** A second, bigger server; `docker` keeps its containers and lines across reconnects. */
async function addServer(app, hostname = 'rack-2') {
  const { token } = await app.hosted.local.servers.createEnrolment('lan-dev');
  const agent = startMockAgent({ identity: { token }, facts: { hostname, memoryMb: 16_384 } });
  app.hosted.agents.attach(agent.transport, { address: '192.168.1.30' });
  const w = await agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.server(w.server))?.allocatable && app.hosted.agents.isOnline(w.server)));
  return { id: w.server, credential: w.credential, docker: agent.docker };
}

test('8.9.9 log lines and stats reach telemetry.subscribe() and the events, with the plan\'s limits', { timeout: 30_000 }, async () => {
  const { app, platform } = await start();
  const got = { logs: [], metrics: [], other: [], events: [] };
  const off = platform.telemetry.subscribe({ onLogs: (p) => got.logs.push(p), onMetrics: (p) => got.metrics.push(p) });
  platform.telemetry.subscribe({ tenantId: 'someone-else', onLogs: (p) => got.other.push(p), onMetrics: (p) => got.other.push(p) });
  for (const type of ['infrastructure.telemetry.logs', 'infrastructure.telemetry.metrics']) app.eventEmitter.on(type, (p) => got.events.push({ type, ...p }));
  try {
    await platform.workloads.create(TENANT, spec(), { actor });
    await app.hosted.idle();
    const [inst] = await app.hosted.local.runtime.list();
    const docker = app.hosted.local.agent.docker;

    // R3: a console line arrives within 3 s, tagged.
    const t0 = Date.now();
    docker.emit(inst.name, 'GET / 200 3ms');
    assert.ok(await until(() => got.logs.some((p) => p.lines.some((l) => l.line === 'GET / 200 3ms'))));
    assert.ok(Date.now() - t0 < 3000);
    const line = got.logs.flatMap((p) => p.lines).find((l) => l.line === 'GET / 200 3ms');
    assert.deepEqual(Object.keys(line).sort(), ['at', 'instance', 'line', 'seq', 'stream', 'tenantId', 'workload']);
    assert.deepEqual([line.tenantId, line.workload, line.instance, line.stream], [TENANT, 'hello', inst.name, 'stdout']);

    // R1: a sample per instance every interval, { value, unit, limit }; a CPU burner shows at the plan's limit.
    docker.setUsage(inst.name, { cpu: 0.5, memoryMb: 300, rxBytes: 5000, txBytes: 9000 });
    assert.ok(await until(() => got.metrics.some((p) => p.samples.some((x) => x.cpu.value === 0.5)), 8000), 'a sample after the change');
    const sample = got.metrics.flatMap((p) => p.samples).find((x) => x.cpu.value === 0.5);
    assert.deepEqual(sample.cpu, { value: 0.5, unit: 'vCPU', limit: 0.5 });
    assert.deepEqual(sample.memory, { value: 300, unit: 'MB', limit: 512 });
    assert.deepEqual([sample.netIn.value, sample.netOut.value], [5000, 9000]);
    assert.equal(sample.instance, inst.name);

    // The short buffer, and the provider's view of the server's totals (8.9.4 metrics.vm).
    const kept = await platform.telemetry.metrics(TENANT, 'hello');
    assert.equal(kept.keptMinutes, 15);
    assert.ok(kept.instances[0].samples.some((x) => x.cpu.value === 0.5));
    await assert.rejects(platform.telemetry.metrics('someone-else', 'hello'), (e) => e.code === 'not_found');
    const vm = await app.hosted.local.provider('lan-dev').metrics.vm(inst.server);
    assert.equal(vm.cpuPercent, 12.5, '0.5 vCPU of 4 CPUs');
    assert.equal(vm.memoryMb, 300);
    const row = (await app.hosted.local.servers.servers()).find((x) => x.id === inst.server);
    assert.ok(row, 'the server');

    // The events carry the same; a subscriber for another tenant hears nothing; unsubscribe stops delivery.
    assert.ok(got.events.some((e) => e.type === 'infrastructure.telemetry.logs' && e.tenantId === TENANT));
    assert.ok(got.events.some((e) => e.type === 'infrastructure.telemetry.metrics' && e.samples[0].instance === inst.name));
    assert.deepEqual(got.other, []);
    off();
    const before = got.logs.length;
    docker.emit(inst.name, 'after unsubscribe');
    assert.ok(await until(async () => (await platform.logs.tail(TENANT, 'hello')).lines.some((l) => l.line === 'after unsubscribe')));
    assert.equal(got.logs.length, before);
  } finally {
    await app.close();
  }
});

test('8.5 a workload\'s instances for the launcher\'s tiles: status, start time, restarts, the plan; the mock\'s stats drift', { timeout: 30_000 }, async () => {
  const { app, platform } = await start();
  try {
    await platform.workloads.create(TENANT, spec({ instances: 2 }), { actor });
    await app.hosted.idle();
    const list = await platform.workloads.instances(TENANT, 'hello');
    assert.equal(list.length, 2);
    for (const i of list) {
      assert.deepEqual([i.status, i.restarts, i.lastExitCode, i.plan], ['running', 0, null, { cpu: 0.5, memoryMb: 512 }]);
      assert.ok(Date.parse(i.startedAt) <= Date.now());
      assert.match(i.server, /^srv_/);
    }
    await assert.rejects(platform.workloads.instances('someone-else', 'hello'), (e) => e.code === 'not_found');

    // A crash Docker restarts shows as a restart, with the exit code.
    const docker = app.hosted.local.agent.docker;
    docker.crash(list[0].instance, 137);
    await app.hosted.local.runtime.statsNow(list[0].server);
    assert.ok(await until(async () => (await platform.workloads.instances(TENANT, 'hello')).find((i) => i.instance === list[0].instance)?.restarts === 1));
    assert.equal((await platform.workloads.instances(TENANT, 'hello')).find((i) => i.instance === list[0].instance).lastExitCode, 137);
    // Its follow ended with the run; what it writes after the restart still arrives (followed again from the last line).
    docker.emit(list[0].instance, 'back after the crash');
    await app.hosted.local.runtime.statsNow(list[0].server);
    assert.ok(await until(async () => (await platform.logs.tail(TENANT, 'hello')).lines.some((l) => l.line === 'back after the crash'), 5000), 'lines after a restart');
    const exits = (await platform.logs.tail(TENANT, 'hello')).lines.filter((l) => l.line === 'exited with code 137');
    assert.equal(exits.length, 1, 'the resume skips what was delivered');

    // Without setUsage, the mock's numbers stay inside the plan's limits and its network counters only grow.
    const [a, b] = [await docker.stats({}), await new Promise((r) => setTimeout(r, 20)).then(() => docker.stats({}))];
    for (const x of [...a, ...b]) {
      assert.ok(x.cpu > 0 && x.cpu <= 0.5, `cpu ${x.cpu}`);
      assert.ok(x.memoryMb > 0 && x.memoryMb <= 512, `memory ${x.memoryMb}`);
    }
    assert.ok(b[0].txBytes >= a[0].txBytes);
  } finally {
    await app.close();
  }
});

test('8.9.9 a server that drops and returns resumes its logs: no line lost, none twice; its samples stop meanwhile', { timeout: 30_000 }, async () => {
  const { app, platform } = await start();
  try {
    const big = await addServer(app);
    await platform.workloads.create(TENANT, spec(), { actor });
    await app.hosted.idle();
    const [inst] = await app.hosted.local.runtime.list();
    assert.equal(inst.server, big.id);
    const lines = async () => (await platform.logs.tail(TENANT, 'hello')).lines.filter((l) => /^line /.test(l.line)).map((l) => l.line);

    // Several lines in the same millisecond, the case a timestamp cursor gets wrong.
    for (const n of [1, 2, 3]) big.docker.emit(inst.name, `line ${n}`);
    assert.ok(await until(async () => (await lines()).length === 3));
    assert.ok(await until(async () => (await app.hosted.local.runtime.list())[0].logAt), 'the cursor is kept');

    app.hosted.agents.disconnect(big.id, 'Blip (test).', { retry: true });
    assert.ok(await until(async () => (await app.hosted.local.runtime.list())[0]?.status === 'unknown'));
    assert.equal(app.hosted.local.runtime.serverStats(big.id), null, 'a gap, not stale numbers');
    for (const n of [4, 5]) big.docker.emit(inst.name, `line ${n}`); // written while the controller can't hear

    const back = startMockAgent({ identity: { server: big.id, credential: big.credential }, docker: big.docker });
    app.hosted.agents.attach(back.transport, { address: '192.168.1.30' });
    await back.welcome;
    assert.ok(await until(async () => (await lines()).length >= 5));
    big.docker.emit(inst.name, 'line 6');
    assert.ok(await until(async () => (await lines()).length >= 6));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await lines(), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
  } finally {
    await app.close();
  }
});

test('8.9.4 the local provider: the contract over a site; servers are enrolled, not created', async () => {
  const { app } = await start();
  try {
    const p = app.hosted.local.provider('lan-dev');
    assert.deepEqual(missingMethods(p), []);
    assert.equal(p.name, 'local');
    const v = await p.account.verify();
    assert.equal(v.ok, true);
    assert.match(v.identity, /Local network \(1 server online\)/);
    assert.deepEqual(await p.account.regions(), [{ id: 'lan-dev', label: 'Local network', zones: ['lan-dev'] }]);
    assert.deepEqual(await p.catalog.machineTypes('lan-dev'), []);

    const [vm] = await p.compute.list();
    assert.equal(vm.status, 'running');
    assert.equal(vm.privateIp, '192.168.1.20');
    assert.deepEqual(vm.allocatable, { cpu: 3.75, memoryMb: 7680 });
    assert.match(vm.warnings[0], /user namespaces/);
    assert.deepEqual(await p.compute.get(vm.id), vm);
    assert.equal(await p.compute.defaultAddress(vm.id), '192.168.1.20');
    assert.equal(await p.compute.get('srv_000000000000'), null);

    await assert.rejects(p.compute.create({ name: 'x' }), (e) => e.code === 'invalid' && /enrolled, not created/.test(e.message));
    await assert.rejects(p.compute.remove(vm.id), (e) => e.code === 'invalid' && /Add server/.test(e.message));
    await assert.rejects(p.compute.restart(vm.id), (e) => e.code === 'invalid' && /yourself/.test(e.message));
    await assert.rejects(p.compute.reserveAddress('lan-dev'), (e) => e.code === 'invalid' && /LAN only/.test(e.message));
    await assert.rejects(p.account.zones('elsewhere'), (e) => e.code === 'invalid');
    assert.deepEqual((await p.inventory()).vms.map((x) => x.id), [vm.id]);

    // Through the provider registry, as an account would reach it: only once local servers are on.
    const registry = createProviders({ enabled: ['mock'], store: null, secrets: null, catalog: null });
    await assert.rejects(registry.forAccount({ id: 'acct-lan', provider: 'local', region: 'lan-dev' }), (e) => e.code === 'unavailable');
    registry.useLocal((site) => app.hosted.local.provider(site));
    assert.equal((await registry.forAccount({ id: 'acct-lan', provider: 'local', region: 'lan-dev' })).name, 'local');

    // No server online: verify says so in plain words.
    app.hosted.agents.disconnect(vm.id, 'Stopped (test).', { retry: true });
    assert.ok(await until(async () => (await p.account.verify()).ok === false));
    assert.match((await p.account.verify()).message, /No server of Local network is online/);
    assert.equal((await p.compute.get(vm.id)).status, 'offline');
    assert.equal((await p.metrics.vm(vm.id)).cpuPercent, null);
  } finally {
    await app.close();
  }
});
