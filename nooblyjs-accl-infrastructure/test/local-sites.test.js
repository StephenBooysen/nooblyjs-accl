// Spec 8.9.3 over HTTP (R1, R2, R4, R12, R13): operators list sites and servers, create a site (which becomes a
// region), make a one-time enrolment token with Add server (an agent enrols with it once), and remove a server (its
// channel closes and its credential is refused). Nobody without change-guardrails reaches any of it.
import { controllerOf } from '../src/routes/agent-files.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { startMockAgent } from '../agent/mock.js';

const API = '/infrastructure/api/v1/platform/local';
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

async function start() {
  const app = await startApp({
    platform: { enabled: true },
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock' },
    agents: { checkMs: 0 },
  });
  await app.hosted.local.agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.servers())[0]?.status === 'online'));
  return app;
}

test('8.9.3 operators see sites and servers with facts, allocatable, warnings and agent version', async () => {
  const t = await start();
  try {
    const res = await t.get(API, { as: 'stevie' });
    assert.equal(res.status, 200);
    assert.equal(res.json.agentVersion, '0.1.0');
    const [site] = res.json.sites;
    assert.equal(site.id, 'lan-dev');
    assert.equal(site.online, 1);
    const [server] = site.servers;
    assert.equal(server.status, 'online');
    assert.equal(server.outdated, false);
    assert.deepEqual(server.allocatable, { cpu: 3.75, memoryMb: 7680 });
    assert.deepEqual(server.reserved, { cpu: 0, memoryMb: 0 });
    assert.match(server.warnings[0], /user namespaces/);
    assert.equal(server.credentialHash, undefined);
    assert.equal(JSON.stringify(res.json).includes('credential'), false, 'no credential or hash in the answer');

    assert.equal((await t.get(`${API}/servers/${server.id}`, { as: 'stevie' })).json.hostname, server.hostname);
    assert.equal((await t.get(`${API}/servers/srv_nope12345`, { as: 'stevie' })).status, 404);
    assert.equal((await t.get(`${API}/sites/nowhere`, { as: 'stevie' })).status, 404);
  } finally {
    await t.close();
  }
});

test('8.9.3 nobody without change-guardrails reaches sites and servers', async () => {
  const t = await start();
  try {
    const [server] = await t.hosted.local.servers.servers();
    for (const who of ['naledi-k', 'priya-s', 'lerato-m']) {
      assert.equal((await t.get(API, { as: who })).status, 403, who);
      assert.equal((await t.post(`${API}/sites`, { as: who, body: { id: 'lan-two' } })).status, 403, who);
      assert.equal((await t.post(`${API}/sites/lan-dev/enrolments`, { as: who })).status, 403, who);
      assert.equal((await t.delete(`${API}/servers/${server.id}`, { as: who })).status, 403, who);
    }
    assert.equal((await t.get(API)).status, 401);
    assert.equal((await t.hosted.local.servers.server(server.id)).status, 'online');
  } finally {
    await t.close();
  }
});

test('8.9.3 create a site: checked, refused twice, and a region at once', async () => {
  const t = await start();
  try {
    const bad = await t.post(`${API}/sites`, { as: 'stevie', body: { id: 'Bad Id', bind: '8.8.8.8', reserve: { cpu: -1, memoryMb: 1.5 } } });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.json.error.details.fields).sort(), ['bind', 'id', 'reserve.cpu', 'reserve.memoryMb']);

    const made = await t.post(`${API}/sites`, { as: 'stevie', body: { id: 'lan-office', name: 'Office rack', bind: '192.168.1.20', reserve: { cpu: 0.5, memoryMb: 1024 } } });
    assert.equal(made.status, 201);
    assert.equal(made.json.mode, 'lan');
    assert.deepEqual(made.json.reserve, { cpu: 0.5, memoryMb: 1024 });
    assert.deepEqual(made.json.servers, []);
    assert.equal((await t.post(`${API}/sites`, { as: 'stevie', body: { id: 'lan-office' } })).status, 409);

    const regions = await t.hosted.services.platform.sites();
    assert.ok(regions.some((s) => s.id === 'lan-office' && s.name === 'Office rack'));
    assert.ok(t.auditLog.some((a) => a.actor === 'stevie' && /sites/.test(JSON.stringify(a))), 'the write is audited');
  } finally {
    await t.close();
  }
});

test('8.9.3 Add server: a one-time token and command; the agent enrols once, and Remove server refuses it after', async () => {
  const t = await start();
  try {
    const add = await t.post(`${API}/sites/lan-dev/enrolments`, { as: 'stevie' });
    assert.equal(add.status, 201);
    assert.equal(add.headers.get('cache-control'), 'no-store');
    assert.match(add.json.token, /^enr_/);
    assert.equal(add.json.controller, `${t.base}/infrastructure`);
    assert.equal(add.json.command, `curl -fsSL ${t.base}/infrastructure/agent/install.sh | sudo bash -s -- --token ${add.json.token}`);
    assert.ok(add.json.manual.includes(`--controller ${t.base}/infrastructure --token ${add.json.token}`));

    // 8.9.10: the script and the agent's files answer without a sign-in, with this controller filled in.
    const script = await fetch(`${t.base}/infrastructure/agent/install.sh`);
    assert.equal(script.status, 200);
    const text = await script.text();
    assert.ok(text.includes(`CONTROLLER="${t.base}/infrastructure"`));
    assert.ok(!text.includes(add.json.token), 'the token is never served');
    for (const f of t.hosted.publicPaths.filter((p) => p.startsWith('/agent/files/'))) {
      assert.equal((await fetch(`${t.base}/infrastructure${f}`)).status, 200, f);
    }
    assert.equal((await fetch(`${t.base}/infrastructure/agent/files/mock.js`)).status !== 200, true, 'only the listed files');
    // A strange Host header is never written into the script.
    const req = (h) => ({ protocol: 'http', get: () => h });
    assert.equal(controllerOf(req('x";rm -rf /;"'), '/infrastructure'), null);
    assert.equal(controllerOf(req('$(id)'), '/infrastructure'), null);
    assert.equal(controllerOf(req('192.168.1.5:11010'), '/infrastructure'), 'http://192.168.1.5:11010/infrastructure');
    assert.ok(Date.parse(add.json.expiresAt) - Date.now() > 59 * 60_000);
    assert.equal((await t.post(`${API}/sites/nowhere/enrolments`, { as: 'stevie' })).status, 404);

    // The agent trades the token for its credential.
    const first = startMockAgent({ identity: { token: add.json.token }, facts: { hostname: 'rack-2' } });
    t.hosted.agents.attach(first.transport, { address: '192.168.1.21' });
    const welcome = await first.welcome;
    assert.ok(welcome.credential);
    assert.ok(await until(async () => (await t.get(API, { as: 'stevie' })).json.sites[0].servers.some((s) => s.id === welcome.server && s.status === 'online')));

    // The token works once.
    const again = startMockAgent({ identity: { token: add.json.token } });
    t.hosted.agents.attach(again.transport, { address: '192.168.1.22' });
    assert.match((await again.refused).reason, /unknown, used or expired/);

    // Remove server: the channel closes, the server leaves the list and stays removed, and its credential is refused.
    const removed = await t.delete(`${API}/servers/${welcome.server}`, { as: 'stevie' });
    assert.deepEqual(removed.json, { id: welcome.server, status: 'removed' });
    assert.equal((await first.refused).retry, false);
    assert.ok(await until(() => !t.hosted.agents.isOnline(welcome.server)));
    await new Promise((r) => setTimeout(r, 50));
    const list = (await t.get(API, { as: 'stevie' })).json.sites[0].servers;
    assert.equal(list.some((s) => s.id === welcome.server), false);
    assert.equal((await t.delete(`${API}/servers/${welcome.server}`, { as: 'stevie' })).status, 404);

    const back = startMockAgent({ identity: { server: welcome.server, credential: welcome.credential } });
    t.hosted.agents.attach(back.transport, { address: '192.168.1.21' });
    assert.match((await back.refused).reason, /Unknown server or credential/);
  } finally {
    await t.close();
  }
});
