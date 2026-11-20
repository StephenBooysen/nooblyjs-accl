// Spec 8.9 (R1, R2, R6–R11) through the platform API, offline: a local site `lan-dev` with the in-process agent
// (mock Docker). A workload in that region builds on the server (its build lines in the deploy log), runs with the
// plan's limits, PORT and its opened secrets, answers at its endpoints, streams its console output, rolls over to a
// new deploy without dropping the old instances first, keeps the old ones when a deploy fails, refuses to overfill
// the site, and goes away when deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { startMockAgent } from '../agent/mock.js';

const TENANT = 'acme';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const spec = (over = {}) => ({
  name: 'hello', kind: 'service', region: 'lan-dev',
  source: { repo: 'https://github.com/render-examples/express-hello-world', branch: 'main' },
  build: { runtime: 'node22', startCommand: 'npm start' },
  run: { port: 10400, env: [{ key: 'GREETING', secretRef: 'hero:svc:1:GREETING' }] },
  plan: { cpu: 0.5, memoryMb: 512 }, instances: 2, healthCheck: { path: '/' }, ...over,
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

async function start() {
  const resolved = [];
  const app = await startApp({
    platform: { enabled: true, resolveSecrets: async (tenantId, refs) => { resolved.push({ tenantId, refs }); return Object.fromEntries(refs.map((r) => [r, 'hi there'])); } },
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock', drainMs: 100 },
    agents: { checkMs: 0 },
  });
  await app.hosted.local.agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.servers())[0]?.status === 'online'));
  return { app, platform: app.hosted.services.platform, docker: app.hosted.local.agent.docker, resolved };
}

test('local site: enrolment, the region list, a deploy with build log, limits, PORT, secrets, endpoints and logs', async () => {
  const { app, platform, docker, resolved } = await start();
  try {
    // R1, R2: the site is a region; the development agent enrolled itself with a one-time token.
    assert.deepEqual(await platform.sites(), [{ id: 'lan-dev', name: 'Local network', mode: 'lan' }]);
    const [server] = await app.hosted.local.servers.servers();
    assert.equal(server.site, 'lan-dev');
    assert.equal(server.credentialHash, undefined, 'the credential hash is never handed out');
    assert.deepEqual(server.allocatable, { cpu: 3.75, memoryMb: 7680 }, 'facts minus the site reserve');
    assert.match(server.warnings[0], /without user namespaces/);

    await platform.workloads.create(TENANT, spec(), { actor });
    await app.hosted.idle();
    const w = await platform.workloads.get(TENANT, 'hello');
    assert.equal(w.status, 'live');

    // The build ran on the server and its lines are in the deploy log; no made-up commit was asked for.
    const [deploy] = (await platform.deploys.list(TENANT, 'hello')).deploys;
    const { log } = await platform.deploys.get(TENANT, 'hello', deploy.id);
    const text = log.map((l) => l.text).join('\n');
    assert.match(text, /Cloning https:\/\/github.com\/render-examples\/express-hello-world \(main\)/);
    assert.match(text, /Built noobly\/[0-9a-f]{12}\/hello:/);
    assert.match(text, /Waiting for all 2 to answer \/ on port 10400/);
    assert.match(text, /Healthy/);

    // R6, R9: two containers with the plan's limits, PORT and the opened secret, on ports from 20000.
    const running = docker.state.containers;
    assert.equal(running.length, 2);
    for (const c of running) {
      assert.deepEqual([c.args.cpu, c.args.memoryMb, c.args.port, c.args.bind], [0.5, 512, 10400, '127.0.0.1']);
      assert.ok(c.args.hostPort >= 20000 && c.args.hostPort <= 29999);
      assert.deepEqual(c.args.env, [{ key: 'GREETING', value: 'hi there' }, { key: 'PORT', value: '10400' }]);
      assert.match(c.args.network, /^noobly-t-[0-9a-f]{12}$/);
      assert.equal(c.labels['noobly-tenant'], TENANT);
    }
    assert.deepEqual(resolved[0], { tenantId: TENANT, refs: ['hero:svc:1:GREETING'] });
    assert.ok(!JSON.stringify(await platform.workloads.get(TENANT, 'hello')).includes('hi there'), 'secret values are never kept in the record');

    // R10: where it answers.
    const endpoints = await platform.workloads.endpoints(TENANT, 'hello');
    assert.equal(endpoints.length, 2);
    for (const e of endpoints) assert.match(e.url, /^http:\/\/127\.0\.0\.1:2\d{4}$/);

    // R11: console output arrives in the tail and as events.
    const events = [];
    app.eventEmitter.on('infrastructure.workload.log', (e) => events.push(e));
    docker.emit(running[0].name, 'GET / 200 3ms');
    assert.ok(await until(async () => (await platform.logs.tail(TENANT, 'hello')).lines.some((l) => l.line === 'GET / 200 3ms')));
    const tail = await platform.logs.tail(TENANT, 'hello');
    assert.ok(tail.lines.some((l) => l.line === 'Listening on port 10400'), 'the start-up line too');
    assert.deepEqual((await platform.logs.tail(TENANT, 'hello', { after: tail.cursor })).lines, []);
    assert.ok(events.some((e) => e.tenantId === TENANT && e.workload === 'hello' && e.lines.some((l) => l.line === 'GET / 200 3ms')));
    await assert.rejects(platform.logs.tail('other', 'hello'), (e) => e.code === 'not_found', 'another tenant sees nothing');
  } finally {
    await app.close();
  }
});

test('local site: a redeploy replaces the instances; a failed deploy keeps the old ones serving', async () => {
  const { app, platform, docker } = await start();
  try {
    await platform.workloads.create(TENANT, spec({ instances: 1 }), { actor });
    await app.hosted.idle();
    const first = docker.state.containers.map((c) => c.name);

    // The launcher hears the new endpoints while the old instance still runs (then it drains and goes).
    const heard = [];
    app.eventEmitter.on('infrastructure.workload.endpoints', async (e) => {
      heard.push({ ...e, running: docker.state.containers.map((c) => c.name), endpoints: (await platform.workloads.endpoints(TENANT, 'hello')).map((x) => x.instance) });
    });
    await platform.workloads.deploy(TENANT, 'hello', { actor });
    await app.hosted.idle();
    const second = docker.state.containers.map((c) => c.name);
    const switched = heard.find((h) => h.endpoints.length && !h.endpoints.includes(first[0]));
    assert.ok(switched, 'an endpoints event after the switch');
    assert.deepEqual([switched.tenantId, switched.workload], [TENANT, 'hello']);
    assert.ok(switched.running.includes(first[0]), 'the old instance was still running when the launcher heard');
    assert.equal(second.length, 1);
    assert.notDeepEqual(second, first, 'new instances replaced the old');

    docker.failNext('container.run', 'Port in use (injected).');
    await platform.workloads.deploy(TENANT, 'hello', { actor });
    await app.hosted.idle();
    const w = await platform.workloads.get(TENANT, 'hello');
    assert.equal(w.status, 'live', 'still live on the previous deploy');
    assert.deepEqual(docker.state.containers.map((c) => c.name), second, 'the old instance never stopped');
    const [failed] = (await platform.deploys.list(TENANT, 'hello')).deploys;
    assert.equal(failed.result, 'failed');
    assert.match(failed.reason, /Port in use/);
  } finally {
    await app.close();
  }
});

test('local site: a host port something else holds is skipped', async () => {
  const { app, platform, docker } = await start();
  try {
    docker.failNext('container.run', 'Bind for 127.0.0.1:20000 failed: port is already allocated');
    await platform.workloads.create(TENANT, spec({ instances: 1 }), { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get(TENANT, 'hello')).status, 'live');
    assert.deepEqual(docker.state.containers.map((c) => c.args.hostPort), [20001]);
  } finally {
    await app.close();
  }
});

test('local site: a site does not grow; delete removes the containers', async () => {
  const { app, platform, docker } = await start();
  try {
    await platform.workloads.create(TENANT, spec({ name: 'huge', plan: { cpu: 4, memoryMb: 65536 }, instances: 1 }), { actor });
    await app.hosted.idle();
    const [d] = (await platform.deploys.list(TENANT, 'huge')).deploys;
    assert.equal(d.result, 'failed');
    assert.match(d.reason, /Site Local network is full/);

    await platform.workloads.create(TENANT, spec({ instances: 1 }), { actor });
    await app.hosted.idle();
    assert.equal(docker.state.containers.length, 1);
    await platform.workloads.remove(TENANT, 'hello', { actor });
    await app.hosted.idle();
    assert.equal(docker.state.containers.length, 0);
    assert.deepEqual(await app.hosted.local.runtime.list(), []);
  } finally {
    await app.close();
  }
});

test('local servers: a used token cannot enrol again; a removed server is refused at hello', async () => {
  const { app } = await start();
  try {
    const servers = app.hosted.local.servers;
    const { token } = await servers.createEnrolment('lan-dev');
    const enrolled = await servers.verify({ type: 'enrol', token, agentVersion: '0.1.0', facts: { hostname: 'box' } });
    await assert.rejects(servers.verify({ type: 'enrol', token, agentVersion: '0.1.0' }), /unknown, used or expired/);
    assert.equal((await servers.verify({ type: 'hello', server: enrolled.server, credential: enrolled.credential })).server, enrolled.server);
    await servers.remove(enrolled.server);
    await assert.rejects(servers.verify({ type: 'hello', server: enrolled.server, credential: enrolled.credential }), /Unknown server/);
  } finally {
    await app.close();
  }
});

/** A second server in lan-dev, enrolled with a token; `docker` keeps its containers across reconnects. */
async function addServer(app, { hostname, memoryMb = 16_384 }) {
  const { token } = await app.hosted.local.servers.createEnrolment('lan-dev');
  const agent = startMockAgent({ identity: { token }, facts: { hostname, memoryMb } });
  app.hosted.agents.attach(agent.transport, { address: '192.168.1.30' });
  const w = await agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.server(w.server))?.allocatable && app.hosted.agents.isOnline(w.server)));
  return { id: w.server, credential: w.credential, docker: agent.docker };
}

test('8.9.7 a lost server: its instance gets no traffic, moves after the wait, and its leftover is removed when it returns', async () => {
  const { app, platform, docker: devDocker } = await start();
  const runtime = app.hosted.local.runtime;
  const moves = [];
  app.eventEmitter.on('infrastructure.workload.instances', (c) => moves.push(c));
  try {
    // The bigger server takes the instance (most free memory first).
    const big = await addServer(app, { hostname: 'rack-2' });
    await platform.workloads.create(TENANT, spec({ instances: 1 }), { actor });
    await app.hosted.idle();
    const [first] = await runtime.list();
    assert.equal(first.server, big.id);
    assert.equal(first.run.env[0].secretRef, 'hero:svc:1:GREETING', 'the record keeps the secret ref, never its value');
    assert.ok(!JSON.stringify(await runtime.list()).includes('hi there'));

    // rack-2 drops: the instance is unknown at once and leaves the endpoints.
    app.hosted.agents.disconnect(big.id, 'Network cable (test).', { retry: true });
    assert.ok(await until(async () => (await runtime.list())[0]?.status === 'unknown'));
    assert.deepEqual(await platform.workloads.endpoints(TENANT, 'hello'), []);
    assert.ok(moves.some((m) => m.change === 'unknown' && m.instance === first.name));

    // Not before the wait.
    assert.deepEqual(await runtime.replaceLost({ afterMs: 60_000 }), { moved: [], stuck: [] });
    assert.equal(devDocker.state.containers.length, 0);

    // After it: built again on the development server (from the recorded commit), started, checked, serving.
    const { moved } = await runtime.replaceLost({ afterMs: 0 });
    assert.equal(moved.length, 1);
    assert.equal(devDocker.state.containers.length, 1);
    assert.ok(devDocker.state.images.includes(first.image), 'the image was built on the new server');
    const [now] = await runtime.list();
    assert.equal(now.status, 'running');
    assert.notEqual(now.server, big.id);
    assert.deepEqual(devDocker.state.containers[0].args.env, [{ key: 'GREETING', value: 'hi there' }, { key: 'PORT', value: '10400' }]);
    assert.equal((await platform.workloads.endpoints(TENANT, 'hello')).length, 1);
    assert.ok(moves.some((m) => m.change === 'moved' && m.to === now.server));
    assert.ok((await platform.logs.tail(TENANT, 'hello')).lines.some((l) => /\[noobly\] Moved to mock-server/.test(l.line)));

    // rack-2 returns with the old container still running: it is removed; the moved instance stays.
    assert.equal(big.docker.state.containers.length, 1);
    const back = startMockAgent({ identity: { server: big.id, credential: big.credential }, docker: big.docker });
    app.hosted.agents.attach(back.transport, { address: '192.168.1.30' });
    await back.welcome;
    assert.ok(await until(() => big.docker.state.containers.length === 0), 'the leftover is removed');
    assert.deepEqual((await runtime.list()).map((i) => i.name), [now.name]);
  } finally {
    await app.close();
  }
});

test('8.9.7 a server back within the wait keeps its instances; with no room elsewhere they stay unknown and it is said once', async () => {
  const { app, platform } = await start();
  const runtime = app.hosted.local.runtime;
  const moves = [];
  app.eventEmitter.on('infrastructure.workload.instances', (c) => moves.push(c));
  try {
    const big = await addServer(app, { hostname: 'rack-2' });
    // 9 GB fits only on rack-2 (the development server has 7.5 GB allocatable).
    await platform.workloads.create(TENANT, spec({ instances: 1, plan: { cpu: 0.5, memoryMb: 9216 } }), { actor });
    await app.hosted.idle();
    const [inst] = await runtime.list();
    assert.equal(inst.server, big.id);

    app.hosted.agents.disconnect(big.id, 'Blip (test).', { retry: true });
    assert.ok(await until(async () => (await runtime.list())[0]?.status === 'unknown'));

    // No room elsewhere: it stays unknown, and the reason is reported once however often the job runs.
    for (let n = 0; n < 3; n += 1) {
      const r = await runtime.replaceLost({ afterMs: 0 });
      assert.equal(r.stuck.length, 1);
      assert.match(r.stuck[0].reason, /Site Local network is full/);
    }
    assert.equal(moves.filter((m) => m.change === 'stuck').length, 1, JSON.stringify(moves));
    assert.equal((await runtime.list())[0].status, 'unknown');

    // It comes back with the container still running: it serves again, as it was.
    const back = startMockAgent({ identity: { server: big.id, credential: big.credential }, docker: big.docker });
    app.hosted.agents.attach(back.transport, { address: '192.168.1.30' });
    await back.welcome;
    assert.ok(await until(async () => (await runtime.list())[0]?.status === 'running'));
    assert.equal((await runtime.list())[0].name, inst.name);
    assert.equal(big.docker.state.containers.length, 1);
    assert.equal((await platform.workloads.endpoints(TENANT, 'hello')).length, 1);
    assert.ok(moves.some((m) => m.change === 'back'));
  } finally {
    await app.close();
  }
});
