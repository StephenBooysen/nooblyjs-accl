// Spec 8.9 task 8.9.10: the real agent against this machine's Docker, opt in (it pulls node:22-bookworm-slim and
// builds an image, so it is slow and needs Docker and git):
//
//   NOOBLY_REAL_DOCKER=1 node --test test/agent-docker.test.js
//
// A tiny Node app in a local Git repository (file://, as --dev allows) is cloned, built with the node22 template,
// run with the limits, PORT and a secret from an env file, health-checked on its published port, followed in its
// logs, listed by its labels and removed. Every command's arguments pass the protocol's own schema first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDocker } from '../agent/docker.js';
import { checkCommand } from '../agent/protocol.js';

const ON = process.env.NOOBLY_REAL_DOCKER === '1';
const INSTALL = 'a1b2c3d4';
const labels = { 'noobly-install': INSTALL, 'noobly-tenant': 'realtest', 'noobly-workload': 'hello' };
const ok = (name, args) => {
  assert.deepEqual(checkCommand(name, args), [], `${name} passes the protocol schema`);
  return args;
};

test('the real agent builds, runs, checks, follows and removes a Node app on this Docker', { skip: !ON && 'set NOOBLY_REAL_DOCKER=1', timeout: 600_000 }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'noobly-real-'));
  const repo = path.join(work, 'repo');
  const docker = createDocker({ stateDir: path.join(work, 'state') });
  const name = `noobly-realtest-hello-${process.pid}`;
  const tag = `noobly/${INSTALL}/hello:0000000`;
  try {
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'hello', version: '1.0.0', scripts: { start: 'node server.js' } }));
    await fs.writeFile(path.join(repo, 'server.js'), [
      "const http = require('node:http');",
      "http.createServer((req, res) => res.end(`hello ${process.env.GREETING}`)).listen(process.env.PORT, () => console.log(`listening on ${process.env.PORT}`));",
    ].join('\n'));
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    execFileSync('git', ['init', '--quiet', '--initial-branch', 'main', repo]);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'hello');

    const lines = [];
    const built = await docker.build(ok('image.build', { tag, labels, runtime: 'node22', source: { repo: `file://${repo}`, branch: 'main' }, startCommand: 'npm start', stream: 'build-1' }), (l) => lines.push(l));
    assert.equal(built.tag, tag);
    assert.match(built.commit, /^[0-9a-f]{40}$/);
    assert.ok(lines.some((l) => /node22 template/.test(l)));

    const port = 10400;
    const hostPort = 29500 + (process.pid % 400);
    await docker.run(ok('container.run', {
      name, image: tag, labels, cpu: 0.5, memoryMb: 256, port, hostPort, bind: '127.0.0.1',
      env: [{ key: 'GREETING', value: 'from the env file' }, { key: 'PORT', value: String(port) }],
    }));
    assert.equal(await fs.readdir(path.join(work, 'state')).then((f) => f.filter((x) => x.endsWith('.env')).length).catch(() => 0), 0, 'the env file is gone once the container exists');

    const health = await docker.health(name, port, '/', 30);
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(await (await fetch(`http://127.0.0.1:${hostPort}/`)).text(), 'hello from the env file');

    const c = await docker.inspect(name);
    assert.equal(c.state, 'running');
    const raw = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0].HostConfig;
    assert.deepEqual([raw.NanoCpus, raw.Memory, raw.ReadonlyRootfs, raw.CapDrop], [5e8, 256 * 1024 * 1024, true, ['ALL']]);

    const seen = [];
    const stop = await docker.logs(name, {}, (out, line) => seen.push(line), () => {});
    const end = Date.now() + 10_000;
    while (!seen.some((l) => l.includes(`listening on ${port}`)) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.ok(seen.some((l) => l.includes(`listening on ${port}`)), seen.join('\n'));

    assert.deepEqual((await docker.list(ok('container.list', { labels }).labels)).map((x) => x.name), [name]);
    await docker.remove(name);
    assert.deepEqual(await docker.list(labels), []);
  } finally {
    try { execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' }); } catch { /* already gone */ }
    try { execFileSync('docker', ['rmi', '--force', tag], { stdio: 'ignore' }); } catch { /* never built */ }
    await fs.rm(work, { recursive: true, force: true });
  }
});
