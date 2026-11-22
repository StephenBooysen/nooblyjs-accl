// Spec 8.9.1: the agent protocol and the in-process mock agent. The protocol has a fixed set of commands and no shell;
// every value is checked on both sides; frames over 1 MB are refused. The mock agent is the real agent session on an
// in-memory Docker: it enrols, runs what it is sent, refuses another install's containers and file:// outside --dev,
// masks secrets in build logs and streams container logs as they are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode, decode, checkCommand, COMMANDS, ProtocolError, MAX_FRAME_BYTES, MAX_LOG_LINE, CUT_MARK,
  isRepoUrl, isBranch, isRootDir, cutLine, maskLine,
} from '../agent/protocol.js';
import { startMockAgent } from '../agent/mock.js';
import { newCredential } from '../agent/core.js';

const INSTALL = 'inst_test01';
const LABELS = { 'noobly-install': INSTALL, 'noobly-tenant': 'acme', 'noobly-workload': 'api' };
const IMAGE = 'noobly/0123abcd/api:abcdef1';
const run = (over = {}) => ({ name: 'noobly-acme-api-1', image: IMAGE, labels: LABELS, cpu: 0.5, memoryMb: 512, port: 3000, hostPort: 20001, bind: '127.0.0.1', env: [{ key: 'NODE_ENV', value: 'production' }], ...over });

/** A controller stand-in: welcomes the agent, sends commands, collects what comes back. */
function controller(transport, { install = INSTALL, credential } = {}) {
  const frames = [];
  const waiting = new Map();
  let first;
  const firstFrame = new Promise((r) => { first = r; });
  transport.onMessage((text) => {
    const f = decode(text, 'agent');
    frames.push(f);
    if (f.type === 'hello' || f.type === 'enrol') first(f);
    if ((f.type === 'result' || f.type === 'error') && waiting.has(f.id)) {
      waiting.get(f.id)(f);
      waiting.delete(f.id);
    }
  });
  let n = 0;
  return {
    frames,
    firstFrame,
    welcome: (heartbeatMs = 15_000) => transport.send(encode({ type: 'welcome', install, server: 'srv_abcdefgh12', ...(credential ? { credential } : {}), expectedAgentVersion: '0.1.0', heartbeatMs })),
    command(name, args) {
      const id = `c${n += 1}`;
      const answer = new Promise((r) => waiting.set(id, r));
      transport.send(encode({ type: 'command', id, name, args }));
      return answer;
    },
    raw: (text) => transport.send(text),
    logs: (stream) => frames.filter((f) => f.type === 'log' && f.stream === stream).flatMap((f) => f.lines),
  };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

test('frames: encode and decode round-trip; size, JSON, version, type and sender are checked', () => {
  const text = encode({ type: 'heartbeat' });
  assert.deepEqual(decode(text, 'agent'), { v: 1, type: 'heartbeat' });
  const fails = (fn, code) => assert.throws(fn, (err) => err instanceof ProtocolError && err.code === code);
  fails(() => decode('{nope', 'agent'), 'bad_json');
  fails(() => decode(JSON.stringify({ v: 2, type: 'heartbeat' }), 'agent'), 'bad_version');
  fails(() => decode(JSON.stringify({ v: 1, type: 'shell' }), 'agent'), 'unknown_type');
  fails(() => decode(encode({ type: 'command', id: 'x1', name: 'facts.get', args: {} }), 'agent'), 'bad_frame'); // an agent never sends commands
  fails(() => decode(encode({ type: 'heartbeat' }), 'controller'), 'bad_frame'); // nor does the controller send heartbeats
  fails(() => encode({ type: 'result', id: 'x', data: 'x'.repeat(MAX_FRAME_BYTES) }), 'too_large');
  fails(() => decode('"' + 'x'.repeat(MAX_FRAME_BYTES) + '"', 'agent'), 'too_large');
  fails(() => decode(encode({ type: 'result', data: {} }), 'agent'), 'invalid'); // answers carry an id
});

test('the command set is fixed and has no shell or exec', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'container.list', 'container.remove', 'container.run', 'container.stop', 'facts.get', 'health.check', 'image.build',
    'image.pull', 'image.push', 'image.remove', 'ingress.counters', 'ingress.sync', 'job.run', 'logs.follow', 'logs.stop', 'network.ensure', 'relay.ensure', 'relay.remove', 'site.export', 'stats.watch',
  ]);
  for (const name of ['exec', 'shell', 'container.exec', 'run', 'docker']) assert.match(checkCommand(name, {})[0].message, /Unknown command/);
});

test('container.run: limits, names, labels, image, ports and environment are checked', () => {
  assert.deepEqual(checkCommand('container.run', run()), []);
  const paths = (args) => checkCommand('container.run', args).map((p) => p.path);
  assert.deepEqual(paths(run({ name: 'api; rm -rf /' })), ['args.name']);
  assert.deepEqual(paths(run({ image: 'evil/image:latest' })), ['args.image']);
  assert.deepEqual(paths(run({ cpu: 0, memoryMb: 10 })), ['args.cpu', 'args.memoryMb']);
  assert.deepEqual(paths(run({ hostPort: 80 })), ['args.hostPort']);
  assert.deepEqual(paths(run({ port: undefined })), ['args.hostPort'], 'a host port needs a container port');
  assert.deepEqual(paths(run({ labels: { 'noobly-tenant': 'acme' } })), ['args.labels.noobly-install']);
  assert.deepEqual(paths(run({ labels: { ...LABELS, 'Bad Key': 'x' } })), ['args.labels.Bad Key']);
  assert.deepEqual(paths(run({ env: [{ key: '1BAD', value: 'x' }, { key: 'A', value: 'x' }, { key: 'A', value: 'y' }] })), ['args.env.0.key', 'args.env.2.key']);
  assert.deepEqual(paths(run({ privileged: true })), ['args.privileged'], 'unknown fields are refused, so no privileged flag can be smuggled in');
  assert.deepEqual(paths(run({ bind: '0.0.0.0; ls' })), ['args.bind']);
});

test('sources: https without credentials or file://; safe branches and folders', () => {
  for (const ok of ['https://github.com/acme/api.git', 'https://git.example.com/a/b', 'file:///srv/samples/hello']) assert.ok(isRepoUrl(ok), ok);
  for (const bad of ['http://github.com/a/b', 'https://user:pw@github.com/a/b', 'git@github.com:a/b.git', '-upload-pack=x', 'file://host/x', 'file:///srv/../etc', 'ssh://x/y']) assert.ok(!isRepoUrl(bad), bad);
  for (const ok of ['main', 'release/1.4', 'feat_x-2']) assert.ok(isBranch(ok), ok);
  for (const bad of ['-x', 'a..b', 'a@{1}', 'x.lock', '/x', 'a b', '']) assert.ok(!isBranch(bad), bad);
  for (const ok of ['', 'apps/api', './x'.slice(2)]) assert.ok(isRootDir(ok), ok);
  for (const bad of ['../etc', 'a/../../b', '/abs', '-x']) assert.ok(!isRootDir(bad), bad);
});

test('log lines are cut at 16 KB and secrets are masked', () => {
  const long = 'x'.repeat(MAX_LOG_LINE + 10);
  assert.equal(cutLine(long).length, MAX_LOG_LINE + CUT_MARK.length);
  assert.ok(cutLine(long).endsWith(CUT_MARK));
  assert.equal(maskLine('token ghp_secret123 used', ['ghp_secret123']), 'token •••• used');
  assert.equal(maskLine('abc', ['ab']), 'abc', 'values under 4 characters are not masked');
});

test('mock agent: enrols with its token, keeps the credential, and sends heartbeats', async () => {
  const credential = newCredential();
  let kept;
  const agent = startMockAgent({ identity: { token: `enr_${'a'.repeat(40)}` }, onWelcome: (w) => { kept = w; } });
  const c = controller(agent.transport, { credential });
  const first = await c.firstFrame;
  assert.equal(first.type, 'enrol');
  assert.equal(first.facts.os, 'Ubuntu 24.04.5 LTS');
  c.welcome(1000);
  await agent.welcome;
  assert.deepEqual(kept, { server: 'srv_abcdefgh12', credential, install: INSTALL });
  assert.ok(await until(() => c.frames.some((f) => f.type === 'heartbeat'), 2500), 'a heartbeat within the interval');
  agent.session.stop();
  await agent.session.closed;
});

test('mock agent: a command before the welcome is refused; an enrolled agent says hello', async () => {
  const agent = startMockAgent({ identity: { server: 'srv_abcdefgh12', credential: newCredential() } });
  const c = controller(agent.transport);
  assert.equal((await c.firstFrame).type, 'hello');
  const early = await c.command('facts.get', {});
  assert.deepEqual([early.type, early.code], ['error', 'refused']);
  agent.session.stop();
});

test('mock agent: build (masked), network, run with the asked limits, health, list, stop, remove', async () => {
  const agent = startMockAgent({ identity: { server: 'srv_abcdefgh12', credential: newCredential() } });
  const c = controller(agent.transport);
  await c.firstFrame;
  c.welcome();
  await agent.welcome;

  const net = await c.command('network.ensure', { name: 'noobly-t-0123abcd', labels: LABELS });
  assert.equal(net.type, 'result');
  const token = 'ghp_verysecrettoken123';
  const built = await c.command('image.build', {
    tag: IMAGE, labels: LABELS, runtime: 'node22', buildCommand: 'npm ci', gitToken: token, stream: 'build-1',
    source: { repo: 'https://github.com/acme/api.git', branch: 'main', commit: 'abcdef1' }, mask: [],
  });
  assert.deepEqual(built.data, { tag: IMAGE, commit: 'abcdef1' });
  await until(() => c.frames.some((f) => f.type === 'stream-end' && f.stream === 'build-1'));
  const buildLog = c.logs('build-1').map((l) => l.line);
  assert.ok(buildLog.includes('Cloning https://github.com/acme/api.git (main) at abcdef1'));
  assert.ok(buildLog.includes('Using credentials ••••'), 'the Git token is masked');
  assert.ok(!JSON.stringify(c.frames).includes(token), 'the token never comes back');

  const started = await c.command('container.run', run({ network: 'noobly-t-0123abcd' }));
  assert.deepEqual(started.data, { name: 'noobly-acme-api-1', state: 'running', hostPort: 20001 });
  const [ctr] = agent.docker.state.containers;
  assert.deepEqual([ctr.args.cpu, ctr.args.memoryMb, ctr.args.bind, ctr.args.network], [0.5, 512, '127.0.0.1', 'noobly-t-0123abcd']);
  assert.equal((await c.command('container.run', run())).code, 'refused', 'a name in use is refused');
  assert.deepEqual((await c.command('health.check', { name: 'noobly-acme-api-1', port: 3000, path: '/health' })).data, { ok: true, status: 200, path: '/health' });
  assert.equal((await c.command('container.list', { labels: LABELS })).data.containers.length, 1);
  assert.equal((await c.command('container.stop', { name: 'noobly-acme-api-1' })).data.state, 'exited');
  assert.equal((await c.command('container.remove', { name: 'noobly-acme-api-1' })).data.removed, true);
  assert.equal((await c.command('container.remove', { name: 'noobly-acme-api-1' })).code, 'not_found');
  agent.session.stop();
});

test('mock agent: another install\'s labels and containers are refused; file:// needs --dev; bad commands are answered, not run', async () => {
  const agent = startMockAgent({ identity: { server: 'srv_abcdefgh12', credential: newCredential() }, dev: false });
  const c = controller(agent.transport);
  await c.firstFrame;
  c.welcome();
  await agent.welcome;

  const other = { ...LABELS, 'noobly-install': 'inst_someone' };
  assert.equal((await c.command('network.ensure', { name: 'noobly-t-0123abcd', labels: other })).code, 'refused');
  assert.equal((await c.command('container.list', { labels: other })).code, 'refused');
  // A container someone else made on this server (not through us) cannot be stopped.
  await agent.docker.build({ tag: IMAGE, labels: other, runtime: 'node22', source: { repo: 'https://x.dev/a/b', branch: 'main' } }, () => {});
  await agent.docker.run(run({ name: 'noobly-foreign-1', labels: other }));
  assert.equal((await c.command('container.stop', { name: 'noobly-foreign-1' })).code, 'refused');

  const local = await c.command('image.build', { tag: IMAGE, labels: LABELS, runtime: 'node22', stream: 'b2', source: { repo: 'file:///srv/samples/hello', branch: 'main' }, mask: [] });
  assert.deepEqual([local.code, local.message], ['refused', 'file:// sources run only on an agent started with --dev.']);

  // A frame the controller library would never send: the agent checks it again and answers with the problems.
  c.raw(JSON.stringify({ v: 1, type: 'command', id: 'evil1', name: 'container.run', args: run({ privileged: true }) }));
  assert.ok(await until(() => c.frames.some((f) => f.type === 'error' && f.id === 'evil1' && f.code === 'invalid')));
  assert.equal(agent.docker.state.containers.length, 1, 'nothing new was started');
  c.raw('not json at all');
  assert.ok(await until(() => c.frames.some((f) => f.type === 'error' && f.id === 'protocol' && f.code === 'bad_json')));
  agent.session.stop();
});

test('mock agent: logs replay, then follow new lines within a fraction of a second; resume from a cursor; stop', async () => {
  const agent = startMockAgent({ identity: { server: 'srv_abcdefgh12', credential: newCredential() } });
  const c = controller(agent.transport);
  await c.firstFrame;
  c.welcome();
  await agent.welcome;
  await agent.docker.build({ tag: IMAGE, labels: LABELS, runtime: 'node22', source: { repo: 'https://x.dev/a/b', branch: 'main' } }, () => {});
  await c.command('container.run', run());

  assert.equal((await c.command('logs.follow', { name: 'noobly-acme-api-1', stream: 'l1' })).type, 'result');
  assert.ok(await until(() => c.logs('l1').some((l) => l.line === 'Listening on port 3000')), 'the earlier line is replayed');
  const t0 = Date.now();
  agent.docker.emit('noobly-acme-api-1', 'GET /health 200');
  agent.docker.emit('noobly-acme-api-1', 'boom', 'stderr');
  assert.ok(await until(() => c.logs('l1').some((l) => l.line === 'boom' && l.out === 'stderr')));
  assert.ok(Date.now() - t0 < 1000, 'well inside 8.5 R3\'s 3 seconds');
  assert.equal((await c.command('logs.follow', { name: 'noobly-acme-api-1', stream: 'l1' })).code, 'refused', 'one follower per stream id');

  const cursor = c.logs('l1').find((l) => l.line === 'GET /health 200').at;
  assert.equal((await c.command('logs.stop', { stream: 'l1' })).type, 'result');
  agent.docker.emit('noobly-acme-api-1', 'after the cursor');
  await c.command('logs.follow', { name: 'noobly-acme-api-1', stream: 'l2', since: cursor });
  assert.ok(await until(() => c.logs('l2').some((l) => l.line === 'after the cursor')));
  assert.ok(!c.logs('l2').some((l) => l.line === 'Listening on port 3000'), 'nothing before the cursor');

  // Removing the container ends its stream.
  await c.command('container.remove', { name: 'noobly-acme-api-1' });
  assert.ok(await until(() => c.frames.some((f) => f.type === 'stream-end' && f.stream === 'l2')));
  agent.session.stop();
});

test('mock agent: stats arrive with each container\'s limits; jobs report exit code and duration', async () => {
  const agent = startMockAgent({ identity: { server: 'srv_abcdefgh12', credential: newCredential() } });
  const c = controller(agent.transport);
  await c.firstFrame;
  c.welcome();
  await agent.welcome;
  await agent.docker.build({ tag: IMAGE, labels: LABELS, runtime: 'node22', source: { repo: 'https://x.dev/a/b', branch: 'main' } }, () => {});
  await c.command('container.run', run());
  await c.command('stats.watch', { labels: LABELS, stream: 's1', intervalS: 5 });
  assert.ok(await until(() => c.frames.some((f) => f.type === 'stats' && f.stream === 's1')));
  const sample = c.frames.find((f) => f.type === 'stats').samples[0];
  assert.deepEqual([sample.cpuLimit, sample.memoryLimitMb], [0.5, 512]);

  const job = await c.command('job.run', { name: 'noobly-acme-etl-1', image: IMAGE, labels: LABELS, cpu: 0.5, memoryMb: 256, command: ['node', 'etl.js'], stream: 'j1' });
  assert.deepEqual(job.data, { exitCode: 0, durationMs: 5, peakMemoryMb: 32 });
  assert.ok(await until(() => c.logs('j1').some((l) => l.line === 'Running node etl.js')));
  agent.session.stop();
  await agent.session.closed;
});

test('8.2.3–8.2.4 the docker run arguments: limits and hardening on every instance; private names only on the tenant network', async () => {
  const { runArgs } = await import('../agent/docker.js');
  const args = runArgs({ ...run(), network: 'noobly-t-0123456789ab', aliases: ['api.acme.internal'] }, { envFile: '/state/env/x.env' });
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.deepEqual([flag('--cpus'), flag('--memory'), flag('--memory-swap'), flag('--pids-limit'), flag('--cap-drop'), flag('--security-opt'), flag('--restart')],
    ['0.5', '512m', '512m', '512', 'ALL', 'no-new-privileges', 'on-failure:5'], 'no swap beyond the plan; restarted five times at most');
  assert.ok(args.includes('--read-only'));
  assert.ok(!args.some((a) => /privileged|--network=host|^host$/.test(a)), 'never privileged, never the host network');
  assert.deepEqual([flag('--network'), flag('--network-alias'), flag('-p')], ['noobly-t-0123456789ab', 'api.acme.internal', '127.0.0.1:20001:3000']);
  assert.equal(args[args.indexOf('--') + 1], IMAGE, 'the image comes after --, so nothing in it reads as a flag');
  assert.ok(!runArgs(run({ aliases: ['api.acme.internal'] })).includes('--network-alias'), 'no network, no alias');

  const paths = (a) => checkCommand('container.run', a).map((p) => p.path);
  assert.deepEqual(paths(run({ network: 'noobly-t-0123456789ab', aliases: ['api.acme.internal'] })), []);
  assert.deepEqual(paths(run({ aliases: ['api.acme.internal'] })), ['args.aliases'], 'an alias needs the tenant network');
  assert.deepEqual(paths(run({ network: 'noobly-t-0123456789ab', aliases: ['evil.com', 'api.acme.internal --privileged'] })), ['args.aliases.0', 'args.aliases.1']);
});

test('8.3 image.push and image.pull: references and registry hosts are checked; a run only takes this install\'s own tags', () => {
  const TAG = 'noobly/0123456789ab/api:abc1234';
  const auth = { server: 'africa-south1-docker.pkg.dev', username: 'oauth2accesstoken', password: 'ya29.secret' };
  const paths = (name, a) => checkCommand(name, a).map((p) => p.path);
  assert.deepEqual(paths('image.push', { tag: TAG, ref: 'africa-south1-docker.pkg.dev/acme-prod/noobly-x/0123456789ab/api:abc1234', auth, stream: 'b-1' }), []);
  assert.deepEqual(paths('image.push', { tag: TAG, ref: 'africa-south1-docker.pkg.dev/p/r:t', stream: 'b-1' }), ['args.auth'], 'a push always has credentials');
  assert.deepEqual(paths('image.pull', { ref: 'nginx:1.27', tag: TAG, stream: 'b-1' }), [], 'a public image needs none');
  assert.deepEqual(paths('image.pull', { ref: 'ghcr.io/acme/api:1.4@sha256:' + 'a'.repeat(64), tag: TAG, stream: 'b-1' }), []);
  for (const ref of ['--privileged', '-v/:/host', 'nginx latest', 'NGINX', 'nginx:1.27; rm -rf /', 'host/../x']) {
    assert.deepEqual(paths('image.pull', { ref, tag: TAG, stream: 'b-1' }), ['args.ref'], ref);
  }
  assert.deepEqual(paths('image.pull', { ref: 'nginx:1.27', tag: 'nginx:1.27', stream: 'b-1' }), ['args.tag'], 'pulled images are tagged into our namespace');
  assert.deepEqual(paths('image.push', { tag: TAG, ref: 'r.example.com/p:t', auth: { ...auth, server: '-r.example.com', username: '--password=x' }, stream: 'b-1' }), ['args.auth.server', 'args.auth.username']);
  assert.deepEqual(paths('image.build', { tag: TAG, labels: LABELS, source: { repo: 'https://github.com/acme/api', branch: 'main' }, runtime: 'node22', buildEnv: [{ key: 'NEXT_PUBLIC_URL', value: 'https://x' }], timeoutS: 30, mask: [], stream: 'b-1' }), ['args.timeoutS']);
});
