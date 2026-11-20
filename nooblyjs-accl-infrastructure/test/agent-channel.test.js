// Spec 8.9.2: the agent channel. The launcher passes WebSocket upgrades through host.onUpgrade, so the accelerator
// still never listens on a port; agents dial <mountPath>/agent/v1 with Node's built-in WebSocket. The first frame is
// hello or enrol (verify decides); heartbeats keep a server online; a silent server goes offline and is closed; the
// agent reconnects with backoff; a refusal without retry stops it; commands go out and are answered by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { createAgentHub, isPrivateAddress, AgentError } from '../src/services/agents.js';
import { createUpgradeRouter } from '../src/host/upgrades.js';
import { connectForever, agentUrl, backoffMs } from '../agent/connect.js';
import { startMockAgent } from '../agent/mock.js';
import { createMockDocker } from '../agent/docker-mock.js';
import { newCredential } from '../agent/core.js';

const INSTALL = 'inst_test01';
const SERVER = 'srv_abcdefgh12';
const quiet = { info() {}, warn() {} };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

/** verify that knows one server and one enrolment token. */
function verifier({ credential = newCredential(), token = `enr_${'t'.repeat(40)}` } = {}) {
  let used = false;
  const fn = async (frame) => {
    if (frame.type === 'hello' && frame.server === SERVER && frame.credential === credential) return { server: SERVER, install: INSTALL };
    if (frame.type === 'enrol' && frame.token === token && !used) {
      used = true;
      return { server: SERVER, install: INSTALL, credential };
    }
    throw new Error('Unknown server or credential.');
  };
  return Object.assign(fn, { credential, token });
}

test('addresses: loopback and private ranges allow plain ws://; public ones do not', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.20', 'fd12:3456::1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '2001:db8::1', '', undefined]) assert.ok(!isPrivateAddress(a), String(a));
  assert.equal(agentUrl('http://localhost:11010'), 'ws://localhost:11010/infrastructure/agent/v1');
  assert.equal(agentUrl('https://cloud.example.com'), 'wss://cloud.example.com/infrastructure/agent/v1');
  assert.equal(agentUrl('http://192.168.1.5:11010/infrastructure'), 'ws://192.168.1.5:11010/infrastructure/agent/v1');
  assert.throws(() => agentUrl('http://cloud.example.com'), /Plain ws:\/\/ is only for localhost or a private address/);
  assert.throws(() => agentUrl('https://u:p@cloud.example.com'), /no credentials/);
  assert.throws(() => agentUrl('ftp://x'), /http\(s\)/);
});

test('backoff: 1 s doubling to 30 s, with jitter', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, () => 0.5)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoffMs(0, () => 0), 750);
  assert.equal(backoffMs(9, () => 1), 37500);
});

test('upgrade router: exact paths, one handler a path, unregister', () => {
  const r = createUpgradeRouter();
  const off = r.onUpgrade('/infrastructure/agent/v1', () => {});
  assert.throws(() => r.onUpgrade('/infrastructure/agent/v1', () => {}), /already answers/);
  assert.throws(() => r.onUpgrade('agent', () => {}), /starts with \//);
  assert.deepEqual(r.paths(), ['/infrastructure/agent/v1']);
  off();
  assert.deepEqual(r.paths(), []);
});

test('hub over the in-memory link: hello, heartbeat, commands by id, silent server goes offline', async () => {
  let t = 1_000_000;
  const statuses = [];
  const verify = verifier();
  const hub = createAgentHub({ verify, now: () => t, checkMs: 0, heartbeatMs: 60_000, log: quiet, onStatus: (s, status) => statuses.push(status) });
  const agent = startMockAgent({ identity: { server: SERVER, credential: verify.credential } });
  hub.attach(agent.transport, { address: '127.0.0.1' });
  await agent.welcome;
  assert.ok(hub.isOnline(SERVER));
  assert.equal(hub.session(SERVER).outdated, false);

  const facts = await hub.command(SERVER, 'facts.get', {});
  assert.equal(facts.os, 'Ubuntu 24.04.5 LTS');
  await assert.rejects(hub.command(SERVER, 'container.stop', { name: 'noobly-nope-1' }), (e) => e instanceof AgentError && e.code === 'not_found');
  await assert.rejects(hub.command(SERVER, 'exec', { cmd: 'ls' }), (e) => e.code === 'invalid', 'checked before it is sent');
  await assert.rejects(hub.command('srv_unknown0000', 'facts.get', {}), (e) => e.code === 'offline');

  t += 44_000;
  hub.check();
  assert.ok(hub.isOnline(SERVER), 'still online at 44 s');
  t += 2_000;
  hub.check();
  assert.ok(!hub.isOnline(SERVER), 'offline after 45 s of silence');
  await agent.session.closed;
  assert.deepEqual(statuses, ['online', 'offline']);
  await hub.close();
});

test('hub: a wrong first frame, a bad credential and a reused token are refused; a second connection replaces the first', async () => {
  const verify = verifier();
  const hub = createAgentHub({ verify, checkMs: 0, log: quiet });

  const bad = startMockAgent({ identity: { server: SERVER, credential: newCredential() } });
  hub.attach(bad.transport);
  assert.deepEqual(await bad.refused, { reason: 'Unknown server or credential.', retry: false, type: 'refused' });
  await bad.session.closed;

  const first = startMockAgent({ identity: { token: verify.token } });
  hub.attach(first.transport);
  assert.equal((await first.welcome).credential, verify.credential, 'enrolment hands over the credential');
  const again = startMockAgent({ identity: { token: verify.token } });
  hub.attach(again.transport);
  assert.equal((await again.refused).reason, 'Unknown server or credential.');
  await again.session.closed;
  assert.ok(hub.isOnline(SERVER), 'the reused token was refused; the enrolled session carries on');

  const second = startMockAgent({ identity: { server: SERVER, credential: verify.credential } });
  hub.attach(second.transport);
  await second.welcome;
  await first.session.closed;
  assert.ok(hub.isOnline(SERVER));
  hub.disconnect(SERVER, 'This server was removed.');
  await second.session.closed;
  assert.ok(!hub.isOnline(SERVER));
  await hub.close();
});

test('mount: the endpoint is passed through host.onUpgrade; an unenrolled agent is refused and stops trying', async () => {
  const app = await startApp();
  try {
    assert.ok(app.hosted.agents, 'the standalone host offers onUpgrade');
    const warnings = [];
    const agent = connectForever({
      controller: app.base, identity: () => ({ server: SERVER, credential: newCredential() }), docker: createMockDocker(),
      facts: async () => ({}), log: { info() {}, warn: (m) => warnings.push(m) },
    });
    assert.deepEqual(await agent.done, { reason: 'This server is not enrolled.' });
    assert.match(warnings.join('\n'), /refused this agent: This server is not enrolled/);

    // Any other upgrade path is a 404.
    const ws = new WebSocket(app.base.replace('http', 'ws') + '/infrastructure/elsewhere');
    const failed = await new Promise((r) => { ws.addEventListener('error', () => r(true)); ws.addEventListener('open', () => r(false)); });
    assert.ok(failed);
  } finally {
    await app.close();
  }
});

test('a launcher without onUpgrade still mounts, without local servers', async () => {
  const app = await startApp({ changeHost: (h) => ({ ...h, onUpgrade: undefined }) });
  try {
    assert.equal(app.mountError, null);
    assert.equal(app.hosted.agents, null);
  } finally {
    await app.close();
  }
});

test('real WebSocket: the agent enrols, keeps its credential, says hello after a restart, and reconnects after the controller drops it', async () => {
  const verify = verifier();
  const app = await startApp({ agents: { verify, heartbeatMs: 1000, checkMs: 0 } });
  try {
    let identity = { token: verify.token };
    const welcomes = [];
    const docker = createMockDocker();
    const agent = connectForever({
      controller: app.base, identity: () => identity, docker, facts: () => docker.facts(), dev: true, log: quiet,
      onWelcome: (w) => {
        welcomes.push(w);
        if (w.credential) identity = { server: w.server, credential: w.credential }; // agent.json: the token is gone
      },
    });
    assert.ok(await until(() => welcomes.length === 1));
    assert.ok(app.hosted.agents.isOnline(SERVER));
    assert.equal(welcomes[0].credential, verify.credential);

    // Commands over the real socket.
    const facts = await app.hosted.agents.command(SERVER, 'facts.get', {});
    assert.equal(facts.hostname, 'mock-server');
    // Heartbeats move lastSeenAt.
    const seen = app.hosted.agents.session(SERVER).lastSeenAt;
    assert.ok(await until(() => app.hosted.agents.session(SERVER)?.lastSeenAt > seen, 2500), 'a heartbeat arrived');

    // A bye with retry (the controller stopping): the agent comes back with hello, not the used token.
    app.hosted.agents.disconnect(SERVER, 'Restarting.', { retry: true });
    assert.ok(await until(() => welcomes.length === 2, 4000), 'reconnected after the backoff');
    assert.equal(welcomes[1].credential, undefined, 'hello gets no new credential');
    assert.ok(app.hosted.agents.isOnline(SERVER));

    // A bye without retry (R12: a removed server) stops the agent.
    app.hosted.agents.disconnect(SERVER, 'This server was removed.');
    assert.deepEqual(await agent.done, { reason: 'This server was removed.' });

  } finally {
    await app.close();
  }
});

test('real WebSocket: a dropped connection is retried, and the agent says hello again', async () => {
  const verify = verifier();
  const sockets = [];
  const app = await startApp({
    agents: { verify, checkMs: 0 },
    // Keep the upgraded sockets, to cut one like a network failure would.
    changeHost: (h) => ({ ...h, onUpgrade: (p, handler) => h.onUpgrade(p, (req, socket, head) => { sockets.push(socket); handler(req, socket, head); }) }),
  });
  try {
    const docker = createMockDocker();
    const agent = connectForever({ controller: app.base, identity: () => ({ server: SERVER, credential: verify.credential }), docker, facts: () => docker.facts(), log: quiet });
    assert.ok(await until(() => app.hosted.agents.isOnline(SERVER)));
    const firstAt = app.hosted.agents.session(SERVER).connectedAt;
    // Kill the TCP connection under the WebSocket: no bye, so the agent backs off (about 1 s) and comes back.
    sockets.at(-1).destroy();
    assert.ok(await until(() => !app.hosted.agents.isOnline(SERVER), 2000), 'offline when the socket dies');
    assert.ok(await until(() => app.hosted.agents.session(SERVER)?.connectedAt > firstAt, 4000), 'back within the first backoff');
    agent.stop();
    await agent.done;
  } finally {
    await app.close();
  }
});
