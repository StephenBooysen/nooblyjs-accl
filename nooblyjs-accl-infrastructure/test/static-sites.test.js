// Spec 8.8 where the platform serves sites itself (a local site, the mock cloud), offline: a `static` workload builds
// once, its publish directory comes back from the agent as a tar and is stored by content hash; the site switches to a
// deploy in one write (no mix of old and new files), serves with cache headers, ETags, SPA fallback and the
// _redirects / _headers rules, rolls back at once to any of the last deploys kept, keeps nothing running, answers 503
// while suspended, and is gone when deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './helpers.js';
import { pack, unpack, cleanPath } from '../agent/tar.js';
import { parseRedirects, parseHeaders, isHashed, cacheControl, KEEP } from '../src/platform/sites.js';
import { checkCommand, decode, encode } from '../agent/protocol.js';

const TENANT = 'acme';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const spec = (over = {}) => ({
  name: 'web', kind: 'static', region: 'lan-dev',
  source: { repo: 'https://github.com/acme/web', branch: 'main' },
  build: { runtime: 'node22', buildCommand: 'npm ci && npm run build', publishDir: 'dist' }, ...over,
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const body = (r) => r.body?.toString('utf8') ?? null;

async function start() {
  const app = await startApp({
    platform: { enabled: true },
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock', drainMs: 50 },
    agents: { checkMs: 0 },
  });
  await app.hosted.local.agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.servers())[0]?.status === 'online'));
  return { app, platform: app.hosted.services.platform, docker: app.hosted.local.agent.docker };
}

test('8.8 tar: ustar, PAX and GNU long names read back; links and paths outside the site are skipped', () => {
  const long = `dist/${'folder/'.repeat(20)}deep.txt`;
  const tar = pack([{ path: 'dist', type: '5' }, { path: 'dist/index.html', data: '<h1>hi</h1>' }, { path: long, data: 'x' }, { path: 'dist/link', type: '2' }, { path: 'dist/../evil', data: 'no' }]);
  const { files, skipped } = unpack(tar, { stripFirst: true });
  assert.deepEqual(files.map((f) => [f.path, f.data.toString()]), [['index.html', '<h1>hi</h1>'], [long.slice(5), 'x']]);
  assert.deepEqual(skipped.map((s) => s.why), ['a symbolic link', 'not a path inside the site']);
  assert.throws(() => unpack(tar, { stripFirst: true, maxFiles: 1 }), /more than 1 files/);
  assert.throws(() => unpack(tar.subarray(0, 700)), /ends in the middle/);
  assert.deepEqual([cleanPath('a//b/./c'), cleanPath('../x'), cleanPath('a/\u0001')], ['a/b/c', null, null]);
});

test('8.8 rules and caching: _redirects and _headers say which lines they ignore; hashed files are immutable', () => {
  const r = parseRedirects('# comment\n/old /new\n/a/* /b/:splat 302\n/spa/* /index.html 200!\nold /x\n/q /x 418\n/c /d 301 Country=za\n');
  assert.deepEqual(r.rules, [
    { from: '/old', to: '/new', status: 301, force: false },
    { from: '/a/*', to: '/b/:splat', status: 302, force: false },
    { from: '/spa/*', to: '/index.html', status: 200, force: true },
  ]);
  assert.deepEqual(r.problems.map((p) => p.line), [5, 6, 7]);
  const h = parseHeaders('/*\n  X-Frame-Options: DENY\n  Set-Cookie: a=b\n/assets/*\n  Cache-Control: no-store\nbad\n');
  assert.deepEqual(h.rules, [{ path: '/*', headers: { 'x-frame-options': 'DENY' } }, { path: '/assets/*', headers: { 'cache-control': 'no-store' } }]);
  assert.deepEqual(h.problems.map((p) => p.message), ['Set-Cookie is set by the platform.', 'A path starting with /.']);
  assert.deepEqual(['assets/index-B3x9_kQa.js', 'main.3f2a91c8.css', 'logo.png', 'app-abcdefgh.js'].map(isHashed), [true, true, false, false]);
  assert.deepEqual(['/index.html', '/assets/index-B3x9_kQa.js', '/robots.txt'].map(cacheControl), ['no-cache', 'public, max-age=31536000, immutable', 'public, max-age=3600']);
});

test('8.8 protocol: site.export takes a folder inside the build; chunk frames carry base64', () => {
  const ok = { tag: 'noobly/0123456789ab/web:abc1234', labels: { 'noobly-install': 'i1' }, dir: 'dist', maxBytes: 1000, stream: 'x-1' };
  assert.deepEqual(checkCommand('site.export', ok), []);
  for (const dir of ['../x', '/abs', 'dist/', '-x', '']) assert.ok(checkCommand('site.export', { ...ok, dir }).length, dir);
  assert.deepEqual(checkCommand('site.export', { ...ok, dir: '.' }), []);
  const frame = decode(encode({ type: 'chunk', stream: 'x-1', seq: 0, data: Buffer.from('hi').toString('base64') }), 'agent');
  assert.equal(Buffer.from(frame.data, 'base64').toString(), 'hi');
});

test('8.8 local site: build once, upload, serve with headers and rules, switch whole, roll back, keep the last deploys', async () => {
  const { app, platform, docker } = await start();
  try {
    let version = 1;
    docker.siteFiles(() => [
      { path: 'index.html', data: `<h1>v${version}</h1>` },
      { path: `assets/app-Ab12cd${version}9.js`, data: `js${version}` },
      { path: 'about/index.html', data: 'about' },
      { path: '404.html', data: 'missing' },
      { path: '_redirects', data: '/old /about/ 301\n/blog/:slug /index.html 200\nnot a rule\n' },
      { path: '_headers', data: '/*\n  X-Frame-Options: DENY\n' },
    ]);
    await platform.workloads.create(TENANT, spec(), { actor });
    await app.hosted.idle();
    const w = await platform.workloads.get(TENANT, 'web');
    assert.deepEqual([w.status, w.build.publishDir, w.site, w.instances], ['live', 'dist', { spa: false }, 1]);
    assert.equal(docker.state.containers.length, 0, 'nothing keeps running');
    assert.deepEqual(docker.exports.map((e) => e.dir), ['dist']);

    const [first] = (await platform.deploys.list(TENANT, 'web')).deploys;
    const text = (await platform.deploys.get(TENANT, 'web', first.id)).log.map((l) => l.text).join('\n');
    assert.match(text, /Copying the publish directory \(dist\) from the built image on mock-server/);
    assert.match(text, /Uploaded 4 files \(1 KB\); 4 new since the last deploy/);
    assert.match(text, /Rules: 2 redirects, 1 header path/);
    assert.match(text, /_redirects line 3 ignored: The first part is a path starting with \//);
    assert.match(text, /Serving the new files$/);

    const get = (path, o = {}) => platform.staticSites.respond(TENANT, 'web', { method: 'GET', path, ...o });
    let r = await get('/');
    assert.deepEqual([r.status, body(r), r.headers['cache-control'], r.headers['content-type'], r.headers['x-frame-options']], [200, '<h1>v1</h1>', 'no-cache', 'text/html; charset=utf-8', 'DENY']);
    assert.equal((await get('/', { headers: { 'if-none-match': r.headers.etag } })).status, 304);
    r = await get('/assets/app-Ab12cd19.js');
    assert.deepEqual([r.status, r.headers['cache-control'], r.headers['content-type']], [200, 'public, max-age=31536000, immutable', 'text/javascript; charset=utf-8']);
    assert.deepEqual([(await get('/about')).status, (await get('/about')).headers.location], [301, '/about/']);
    assert.equal(body(await get('/about/')), 'about');
    assert.equal((await get('/old', { query: 'x=1' })).headers.location, '/about/?x=1');
    assert.equal(body(await get('/blog/hello')), '<h1>v1</h1>');
    assert.deepEqual([(await get('/nope')).status, body(await get('/nope'))], [404, 'missing']);
    assert.equal((await get('/_redirects')).status, 404, 'the rule files are not served');
    assert.equal((await get('/../secret')).status, 400);
    assert.equal((await platform.staticSites.respond(TENANT, 'web', { method: 'POST', path: '/' })).status, 405);
    const head = await platform.staticSites.respond(TENANT, 'web', { method: 'HEAD', path: '/' });
    assert.deepEqual([head.status, head.body, head.headers['content-length']], [200, null, '11']);

    // SPA: changed on the record, no rebuild, applies at once.
    const { operation } = await platform.workloads.update(TENANT, 'web', { site: { spa: true } }, { actor });
    assert.equal(operation, null);
    assert.equal(body(await get('/app/route')), '<h1>v1</h1>');
    assert.equal((await get('/missing.png')).status, 404, 'a path with an extension is not the app');

    // A second deploy: while it builds the old files serve; then all of the new ones do.
    version = 2;
    const release = docker.holdBuilds();
    await platform.workloads.deploy(TENANT, 'web', { actor });
    assert.ok(await until(() => docker.buildsRunning === 1));
    assert.equal(body(await get('/')), '<h1>v1</h1>', 'the old site serves during the deploy');
    release();
    await app.hosted.idle();
    assert.equal(body(await get('/')), '<h1>v2</h1>');
    assert.equal((await get('/assets/app-Ab12cd19.js')).status, 404, 'no old file is mixed in');

    // Roll back to the first deploy: at once, as a deploy of its own.
    await assert.rejects(platform.staticSites.rollback(TENANT, 'web', (await platform.workloads.get(TENANT, 'web')).current.deployId, { actor }), /the one serving now/);
    const { deploy, workload } = await platform.staticSites.rollback(TENANT, 'web', first.id, { actor });
    assert.deepEqual([deploy.trigger, deploy.result, deploy.serves, deploy.commit, workload.current.serves], ['rollback', 'live', first.id, first.commit, first.id]);
    assert.equal(body(await get('/')), '<h1>v1</h1>');
    assert.equal((await get('/assets/app-Ab12cd19.js')).status, 200);

    // Deploys past KEEP + 1 drop the oldest files; rolling back to one is refused.
    for (version = 3; version <= KEEP + 3; version += 1) {
      await platform.workloads.deploy(TENANT, 'web', { actor });
      await app.hosted.idle();
    }
    const info = await platform.staticSites.info(TENANT, 'web');
    assert.equal(info.deploys.length, KEEP + 1);
    assert.ok(!info.deploys.some((d) => d.deployId === first.id));
    await assert.rejects(platform.staticSites.rollback(TENANT, 'web', first.id, { actor }), /not kept any more/);
    assert.ok(info.stats.requests > 10 && info.stats.hits > 0, JSON.stringify(info.stats));
    const blobs = await fs.readdir(path.join(app.dataDir, 'static', 'sites', TENANT, 'web', 'blobs'), { recursive: true });
    assert.ok(blobs.filter((b) => b.length > 20).length <= (KEEP + 1) * 2 + 3, `old blobs were removed (${blobs.length})`);

    // Suspended: 503; resumed: serves again; deleted: gone.
    await platform.workloads.suspend(TENANT, 'web', { actor });
    await app.hosted.idle();
    assert.equal((await get('/')).status, 503);
    await platform.workloads.resume(TENANT, 'web', { actor });
    await app.hosted.idle();
    assert.equal((await get('/')).status, 200);
    await platform.workloads.remove(TENANT, 'web', { actor });
    await app.hosted.idle();
    assert.equal((await get('/')).status, 404);
    await assert.rejects(fs.access(path.join(app.dataDir, 'static', 'sites', TENANT, 'web')));
  } finally {
    await app.close();
  }
});

test('8.8 a deploy with no publish directory fails and the site before keeps serving', async () => {
  const { app, platform, docker } = await start();
  try {
    await platform.workloads.create(TENANT, spec(), { actor });
    await app.hosted.idle();
    assert.match(body(await platform.staticSites.respond(TENANT, 'web', { path: '/' })), /Built from noobly\//);
    docker.siteFiles(() => null);
    await platform.workloads.deploy(TENANT, 'web', { actor });
    await app.hosted.idle();
    const [latest] = (await platform.deploys.list(TENANT, 'web')).deploys;
    assert.equal(latest.result, 'failed');
    assert.match(latest.reason, /There is no dist folder after the build/);
    assert.equal((await platform.workloads.get(TENANT, 'web')).status, 'live');
    assert.match(body(await platform.staticSites.respond(TENANT, 'web', { path: '/' })), /Built from noobly\//);
    docker.siteFiles(() => []);
    await platform.workloads.deploy(TENANT, 'web', { actor });
    await app.hosted.idle();
    assert.match((await platform.deploys.list(TENANT, 'web')).deploys[0].reason, /The publish directory is empty/);
  } finally {
    await app.close();
  }
});

test('8.8 spec: publishDir is a folder inside the build, only for a static site; the mock cloud serves sites too', async () => {
  const app = await startApp({ platform: { enabled: true }, platformStepMs: 0 });
  const platform = app.hosted.services.platform;
  try {
    for (const publishDir of ['../x', '/abs', 'dist/']) {
      await assert.rejects(platform.workloads.create(TENANT, spec({ region: 'af-south-1', build: { runtime: 'node22', publishDir } }), { actor }), (err) => Boolean(err.details?.fields?.['build.publishDir']));
    }
    await assert.rejects(platform.workloads.create(TENANT, { ...spec({ kind: 'service', region: 'af-south-1', name: 'api' }), run: { port: 8080 } }, { actor }), (err) => Boolean(err.details?.fields?.['build.publishDir']));
    await assert.rejects(platform.workloads.create(TENANT, spec({ region: 'af-south-1', site: { spa: 'yes' } }), { actor }), (err) => Boolean(err.details?.fields?.['site.spa']));
    await platform.workloads.create(TENANT, spec({ region: 'af-south-1', build: { runtime: 'node22', publishDir: 'build' } }), { actor });
    await app.hosted.idle();
    const r = await platform.staticSites.respond(TENANT, 'web', { path: '/' });
    assert.equal(r.status, 200);
    assert.match(body(r), /Built from registry\.mock\/acme\/web:/);
  } finally {
    await app.close();
  }
});

test('8.8 the seeded storefront serves its files on the mock cloud and can be deployed again', async () => {
  const app = await startApp({ platform: { enabled: true }, seed: true });
  const platform = app.hosted.services.platform;
  try {
    const r = await platform.staticSites.respond('exclusivity-life', 'storefront', { path: '/posts/static-sites/' });
    assert.equal(r.status, 200);
    assert.match(body(r), /Static sites, switched whole/);
    assert.equal((await platform.staticSites.respond('exclusivity-life', 'storefront', { path: '/assets/style-3be19f4a.css' })).headers['cache-control'], 'public, max-age=31536000, immutable');
    const info = await platform.staticSites.info('exclusivity-life', 'storefront');
    assert.deepEqual([info.current, info.deploys.length], ['dep_seedsto01', 1]);
    await platform.workloads.deploy('exclusivity-life', 'storefront', { actor });
    await app.hosted.idle();
    assert.match(body(await platform.staticSites.respond('exclusivity-life', 'storefront', { path: '/' })), /Built from registry\.mock/);
    const { deploy } = await platform.staticSites.rollback('exclusivity-life', 'storefront', 'dep_seedsto01', { actor });
    assert.equal(deploy.result, 'live');
    assert.match(body(await platform.staticSites.respond('exclusivity-life', 'storefront', { path: '/' })), /The NooblyJS blog/);
  } finally {
    await app.close();
  }
});
