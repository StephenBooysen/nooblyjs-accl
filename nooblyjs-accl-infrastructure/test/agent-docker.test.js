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
import { createDocker, errorLine } from '../agent/docker.js';
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

    // 8.9.9: what stats.watch sends, read from this Docker: CPU in vCPU, memory in MB under the limit, network bytes.
    const [st] = await docker.stats(ok('stats.watch', { labels, stream: 's-real-1' }).labels);
    assert.equal(st.name, name);
    assert.ok(st.memoryMb > 0 && st.memoryMb <= 256, JSON.stringify(st));
    assert.equal(st.memoryLimitMb, 256);
    assert.ok(Number.isFinite(st.cpu) && st.cpu >= 0);
    assert.ok(Number.isInteger(st.rxBytes) && Number.isInteger(st.txBytes));

    // 8.2 R7 on this Docker: the app is killed, Docker restarts it (on-failure), the follow ends with the run, and
    // states() gives the exit code of the run that ended, not the 0 a running container reports.
    let ended = false;
    const stopFollow = await docker.logs(name, {}, () => {}, () => { ended = true; });
    const kill = "const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p))continue;let c='';try{c=fs.readFileSync('/proc/'+p+'/cmdline','utf8')}catch{}if(c==='node\\0server.js\\0')process.kill(+p,'SIGKILL')}";
    execFileSync('docker', ['exec', name, 'node', '-e', kill]);
    let after;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      [after] = await docker.states(labels);
      if (after?.restarts === 1 && after.state === 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    stopFollow();
    assert.deepEqual([after.state, after.restarts], ['running', 1], JSON.stringify(after));
    assert.ok(Number.isInteger(after.exitCode) && after.exitCode > 0, `the run that ended: ${JSON.stringify(after)}`);
    assert.equal(ended, true, 'docker logs --follow ends when the container stops');

    assert.deepEqual((await docker.list(ok('container.list', { labels }).labels)).map((x) => x.name), [name]);
    await docker.remove(name);
    assert.deepEqual(await docker.list(labels), []);
  } finally {
    try { execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' }); } catch { /* already gone */ }
    try { execFileSync('docker', ['rmi', '--force', tag], { stdio: 'ignore' }); } catch { /* never built */ }
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('a failed docker command reports its cause, not the usage text after it', () => {
  const flag = 'docker: invalid argument "127.0.0.1:x:3000" for "-p, --publish" flag: invalid hostPort: x\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun \'docker run --help\' for more information\n';
  assert.equal(errorLine(flag), 'invalid argument "127.0.0.1:x:3000" for "-p, --publish" flag: invalid hostPort: x');
  assert.equal(errorLine('docker: Error response from daemon: Conflict. The container name "/a" is already in use.\nSee \'docker run --help\'.\n'), 'Error response from daemon: Conflict. The container name "/a" is already in use.');
  assert.equal(errorLine('fatal: repository not found\n'), 'fatal: repository not found');
  assert.equal(errorLine(''), '');
});
