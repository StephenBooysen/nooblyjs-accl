// Spec 8.9 (R1, R2, R6–R11) through the platform API, offline: a local site `lan-dev` with the in-process agent
// (mock Docker). A workload in that region builds on the server (its build lines in the deploy log), runs with the
// plan's limits, PORT and its opened secrets, answers at its endpoints, streams its console output, rolls over to a
// new deploy without dropping the old instances first, keeps the old ones when a deploy fails, refuses to overfill
// the site, and goes away when deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

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
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock' },
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

    await platform.workloads.deploy(TENANT, 'hello', { actor });
    await app.hosted.idle();
    const second = docker.state.containers.map((c) => c.name);
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
    assert.deepEqual(await app.hosted.platform?.localRuntime?.list?.() ?? [], []);
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
