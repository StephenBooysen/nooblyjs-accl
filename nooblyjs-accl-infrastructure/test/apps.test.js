// Apps from Git (roadmap 6.3–6.9) on the mock cloud and the mock Git host: a deploy in nine steps (clone with the
// connection's token, build with its log, the environment with secret and linked values, the new container beside the
// old, its health, the endpoint switched, the old one stopped), a push that redeploys through the signed webhook, a
// failed health check that leaves the old version serving, a failed build, stop and start, a crash found, delete, and
// what is checked and who may.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const API = '/infrastructure/api/v1';
const PUBLIC = 'https://cloud.example.com';
const start = () => startApp({ seed: true, options: { publicUrl: PUBLIC } });
const machine = async (t, account, name) => (await (await t.hosted.mockCloud(account)).resources((r) => r.kind === 'vm' && r.name === name))[0];
const appOn = async (t, vm, app) => (await machine(t, 'stevie-prod', vm)).apps?.[app];
const deployBody = (over = {}) => ({
  name: 'orders-v2', repo: 'https://github.com/stevie/orders-api.git', branch: 'main', gitConnection: 'github-stevie', vm: 'web-01',
  port: 3000, restart: 'always', healthCheck: '/healthz',
  env: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'API_KEY', value: 'sk_live_supersecret', secret: true },
    { key: 'DATABASE_URL', link: { database: 'catalog' } },
  ],
  endpoint: { address: 'domain', domain: 'orders.example.com', path: '/' },
  ...over,
});
/** Sends a mock host's delivery to this server, as GitHub would. */
const deliver = (t, d, { headers = {} } = {}) => fetch(d.url.replace(PUBLIC, t.base), { method: 'POST', headers: { ...d.headers, ...headers }, body: d.body })
  .then(async (res) => ({ status: res.status, json: await res.json() }));

test('a deploy from Git: cloned with the token, built, its environment written, started, checked and live on HTTPS', async () => {
  const t = await start();
  try {
    const res = await t.post(`${API}/apps`, { as: 'priya-s', body: deployBody() });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual([res.json.app.status, res.json.app.statusText.startsWith('Building'), res.json.operation.type], ['building', true, 'app.deploy']);
    await t.hosted.idle();

    const app = (await t.get(`${API}/apps/orders-v2`, { as: 'naledi-k' })).json;
    assert.deepEqual([app.status, app.statusText, app.repo, app.branch, app.cloudLabel, app.region], ['live', 'Live', 'stevie/orders-api', 'main', 'GCP', 'africa-south1']);
    assert.match(app.commit, /^[0-9a-f]{7}$/);
    assert.deepEqual([app.endpoint.host, app.endpoint.url], ['orders.example.com', 'https://orders.example.com']);
    assert.deepEqual(app.run.env, [
      { key: 'NODE_ENV', kind: 'plain', value: 'production' },
      { key: 'API_KEY', kind: 'secret' },
      { key: 'DATABASE_URL', kind: 'database', target: 'catalog' },
    ]);
    assert.doesNotMatch(JSON.stringify(app), /supersecret/, 'a secret value never comes back');
    assert.equal(app.lastDeploy.by, 'by Priya S.');

    const vm = await machine(t, 'stevie-prod', 'web-01');
    const a = vm.apps['orders-v2'];
    assert.deepEqual(a.containers.map((c) => [c.state, c.port, c.containerPort, c.restart]), [['running', 30000, 3000, 'always']]);
    assert.match(a.env, /^NODE_ENV=production\nAPI_KEY=sk_live_supersecret\nDATABASE_URL=mongodb:\/\/admin:[^@]+@10\.10\.0\.30:27017\/catalog\?authSource=admin\n$/);
    assert.deepEqual(vm.clones.at(-1), { app: 'orders-v2', repo: 'https://github.com/stevie/orders-api.git', branch: 'main', withToken: true });
    assert.deepEqual(vm.staged, {}, 'the token and the environment file were taken by their scripts');
    assert.match(vm.caddy.sites['orders.example.com'], /reverse_proxy 127\.0\.0\.1:30000/);

    const op = (await t.get(`${API}/operations/${res.json.operation.id}`, { as: 'stevie' })).json;
    assert.deepEqual(op.steps.map((s) => `${s.key} ${s.status}`), ['source done', 'clone done', 'build done', 'env done', 'start done', 'health done', 'switch done', 'retire skipped', 'prune skipped']);
    const [d] = app.deploys;
    assert.deepEqual([d.status, d.step, d.of, d.trigger, d.hasLog], ['live', 9, 9, 'person', true]);
    const log = (await t.get(`${API}/apps/orders-v2/deploys/${d.id}`, { as: 'stevie' })).json.log;
    assert.match(log, /#9 naming to docker\.io\/noobly-app\/orders-v2:[0-9a-f]{12} done/, 'the build output is in the log');
    assert.match(log, /DATABASE_URL: the connection string of catalog/);
    assert.doesNotMatch(log, /supersecret|mock_github_stevie/);

    const logs = (await t.get(`${API}/apps/orders-v2/logs?lines=50`, { as: 'naledi-k' })).json;
    assert.match(logs.lines[0], /orders-v2 listening on port 3000/);
    const deployed = (await t.get(`${API}/activity?kind=app&limit=5`, { as: 'stevie' })).json.activity.map((x) => `${x.verb} ${x.text}`);
    assert.ok(deployed.some((x) => /^Deployed orders-v2 [0-9a-f]{7} to web-01$/.test(x)), deployed.join(' | '));
    assert.ok(deployed.includes('Created app orders-v2 from stevie/orders-api on web-01'));

    // The seeded storefront redeploys: its bucket link brings access keys, and its existing endpoint moves to the new port.
    const again = await t.post(`${API}/apps/storefront/deploy`, { as: 'priya-s' });
    assert.equal(again.status, 202, again.text);
    await t.hosted.idle();
    const shop = await appOn(t, 'web-01', 'storefront');
    assert.match(shop.env, /^MEDIA_BUCKET=stevie-media\nMEDIA_BUCKET_ACCESS_KEY=MOCK[0-9A-F]{16}$/m);
    assert.match(shop.env, /MEDIA_BUCKET_ENDPOINT=https:\/\/storage\.googleapis\.com/);
    assert.match((await machine(t, 'stevie-prod', 'web-01')).caddy.sites['shop.example.com'], /reverse_proxy 127\.0\.0\.1:30001/);
  } finally {
    await t.close();
  }
});

test('a push redeploys through the signed webhook; the old container stops once the new one is healthy', async () => {
  const t = await start();
  try {
    await t.post(`${API}/apps`, { as: 'stevie', body: deployBody({ autoDeploy: true }) });
    await t.hosted.idle();
    const app = (await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json;
    assert.deepEqual(app.webhook, { state: 'active', problem: null });
    const [hook] = t.hosted.mockGit().hooks().filter((h) => h.fullName === 'stevie/orders-api');
    assert.equal(hook.url, `${PUBLIC}/infrastructure/hooks/git/orders-v2`);

    const { commit, deliveries: [d] } = t.hosted.mockGit().push('github', 'stevie/orders-api', 'main', { message: 'Faster checkout', pusher: 'stevie' });
    assert.equal((await deliver(t, d, { headers: { 'X-Hub-Signature-256': 'sha256=0000' } })).status, 401, 'a wrong signature');
    const sent = await deliver(t, d);
    assert.deepEqual([sent.status, sent.json.deploying], [202, true]);
    assert.deepEqual((await deliver(t, d)).json, { duplicate: true }, 'a redelivery starts nothing');
    await t.hosted.idle();

    const after = (await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json;
    assert.deepEqual([after.status, after.commit, after.lastDeploy.by, after.deploys[0].trigger, after.deploys[0].message], ['live', commit.slice(0, 7), 'by push', 'push', 'Faster checkout']);
    const a = await appOn(t, 'web-01', 'orders-v2');
    assert.deepEqual(a.containers.map((c) => c.port), [30001], 'the old container was stopped after the switch');
    assert.match((await machine(t, 'stevie-prod', 'web-01')).caddy.sites['orders.example.com'], /reverse_proxy 127\.0\.0\.1:30001/);

    const other = t.hosted.mockGit().push('github', 'stevie/orders-api', 'develop', { message: 'WIP' }).deliveries[0];
    assert.equal((await deliver(t, other)).json.ignored, 'Only a push to main deploys orders-v2.');
    assert.equal((await fetch(`${t.base}/infrastructure/hooks/git/storefront`, { method: 'POST', body: '{}' })).status, 401, 'no signature, no deploy');
  } finally {
    await t.close();
  }
});

test('a failed health check keeps the previous version serving; a failed build says so in its log; a first deploy fails', async () => {
  const t = await start();
  try {
    await t.post(`${API}/apps`, { as: 'stevie', body: deployBody({ autoDeploy: true }) });
    await t.hosted.idle();
    const bad = 'dead'.padEnd(40, '7');
    const d = t.hosted.mockGit().push('github', 'stevie/orders-api', 'main', { message: 'Break it', commit: bad }).deliveries[0];
    await deliver(t, d);
    await t.hosted.idle();
    const app = (await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json;
    assert.equal(app.status, 'live', 'still live on the old commit');
    assert.notEqual(app.commit, 'dead777');
    assert.equal(app.deploys[0].status, 'failed');
    assert.equal(app.deploys[0].reason, 'The health check failed: GET /healthz did not answer 200 within 60 seconds. The previous version keeps serving.');
    assert.deepEqual((await appOn(t, 'web-01', 'orders-v2')).containers.map((c) => c.port), [30000], 'the new container was removed');
    assert.match((await machine(t, 'stevie-prod', 'web-01')).caddy.sites['orders.example.com'], /127\.0\.0\.1:30000/);
    const failed = (await t.get(`${API}/activity?kind=app&limit=5`, { as: 'stevie' })).json.activity.find((x) => x.verb === 'Failed');
    assert.match(failed.text, /^orders-v2 dead777 on web-01: The health check failed/);

    // A first deploy whose build fails: Failed, with the build's error in the log.
    const broken = await t.post(`${API}/apps`, { as: 'stevie', body: deployBody({ name: 'shop-broken', repo: 'https://github.com/stevie/storefront.git', branch: 'broken-build', endpoint: null, healthCheck: null, env: [] }) });
    assert.equal(broken.status, 202, broken.text);
    await t.hosted.idle();
    const b = (await t.get(`${API}/apps/shop-broken`, { as: 'stevie' })).json;
    assert.deepEqual([b.status, b.statusText, b.deploys[0].reason], ['failed', 'Failed', 'The build failed (docker build exited with 1). The log above says where.']);
    const log = (await t.get(`${API}/apps/shop-broken/deploys/${b.deploys[0].id}`, { as: 'stevie' })).json.log;
    assert.match(log, /ERROR: process "\/bin\/sh -c npm ci --omit=dev" did not complete successfully/);
  } finally {
    await t.close();
  }
});

test('stop and start; a container that exits is Crashed until it runs again; delete removes everything it made', async () => {
  const t = await start();
  try {
    await t.post(`${API}/apps`, { as: 'stevie', body: deployBody({ autoDeploy: true }) });
    await t.hosted.idle();
    assert.equal((await t.post(`${API}/apps/orders-v2/stop`, { as: 'naledi-k' })).status, 403);
    assert.equal((await t.post(`${API}/apps/orders-v2/stop`, { as: 'priya-s' })).status, 202);
    await t.hosted.idle();
    assert.equal((await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json.statusText, 'Stopped');
    assert.equal((await appOn(t, 'web-01', 'orders-v2')).containers[0].state, 'exited');
    assert.equal((await t.post(`${API}/apps/orders-v2/stop`, { as: 'priya-s' })).status, 409);
    await t.post(`${API}/apps/orders-v2/start`, { as: 'priya-s' });
    await t.hosted.idle();
    assert.equal((await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json.status, 'live');

    const vm = await machine(t, 'stevie-prod', 'web-01');
    await (await t.hosted.mockCloud('stevie-prod')).outOfBand(vm.id, { containerExits: 'orders-v2' });
    await t.hosted.runJob('app-containers');
    const crashed = (await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).json;
    assert.deepEqual([crashed.status, crashed.tone, crashed.failure.reason], ['crashed', 'danger', 'The container exited with code 1 (restarted 3 times).']);
    assert.ok((await t.get(`${API}/activity?kind=app&limit=5`, { as: 'stevie' })).json.activity.some((x) => x.verb === 'Crashed'));

    assert.equal((await t.delete(`${API}/apps/orders-v2`, { as: 'priya-s', body: { confirm: 'orders-v2' } })).status, 403, 'deleting needs an Approver');
    assert.equal((await t.delete(`${API}/apps/orders-v2`, { as: 'stevie', body: {} })).status, 422);
    assert.equal((await t.delete(`${API}/apps/orders-v2`, { as: 'stevie', body: { confirm: 'orders-v2' } })).status, 202);
    await t.hosted.idle();
    assert.equal((await t.get(`${API}/apps/orders-v2`, { as: 'stevie' })).status, 404);
    const after = await machine(t, 'stevie-prod', 'web-01');
    assert.deepEqual(after.apps['orders-v2'], undefined);
    assert.equal(after.caddy.sites['orders.example.com'], undefined);
    assert.ok(!(await t.get(`${API}/endpoints`, { as: 'stevie' })).json.endpoints.some((e) => e.app === 'orders-v2'));
    assert.deepEqual(t.hosted.mockGit().hooks().filter((h) => h.fullName === 'stevie/orders-api'), [], 'the webhook was removed');
  } finally {
    await t.close();
  }
});

test('what is sent is checked; a Viewer may not deploy; the list shows each app, its status and what can be done', async () => {
  const t = await start();
  try {
    assert.equal((await t.post(`${API}/apps`, { as: 'naledi-k', body: deployBody() })).status, 403);
    const bad = await t.post(`${API}/apps`, {
      as: 'priya-s',
      body: deployBody({
        name: 'storefront', repo: 'ftp://x', vm: 'catalog-db', port: 'abc',
        env: [{ key: 'lower', value: 'x' }, { key: 'DB', link: { database: 'orders-db' } }, { key: 'MULTI', value: 'a\nb' }],
        endpoint: { address: 'domain', domain: 'shop.example.com', path: '/' },
      }),
    });
    assert.equal(bad.status, 422);
    const f = bad.json.error.details.fields;
    assert.equal(f.name, 'There is already an app called storefront.');
    assert.ok(f.repo && f.vm && f.port && f['env.0.key'] && f['env.2.value']);
    assert.equal(f['endpoint.domain'], 'shop.example.com is already in use.');
    const cross = await t.post(`${API}/apps`, { as: 'priya-s', body: deployBody({ env: [{ key: 'DB', link: { database: 'orders-db' } }] }) });
    assert.equal(cross.json.error.details.fields['env.0.value'], 'orders-db is in stevie-aws and web-01 in stevie-prod: a database only takes connections from VMs in its own account.');
    const stopped = await t.post(`${API}/apps`, { as: 'priya-s', body: deployBody({ vm: 'staging-01' }) });
    assert.match(stopped.json.error.details.fields.vm ?? '', /is stopped|Pick/);

    const list = (await t.get(`${API}/apps`, { as: 'naledi-k' })).json;
    assert.equal(list.counts.all, 6);
    const shop = list.apps.find((a) => a.name === 'storefront');
    assert.deepEqual([shop.statusText, shop.repo, shop.autoDeploy, shop.endpoint.host, shop.can.redeploy], ['Live', 'stevie/storefront', true, 'shop.example.com', true]);
    for (const a of list.apps) assert.ok(a.statusText && a.tone, a.name);
  } finally {
    await t.close();
  }
});

test('VM health counts the last 24 hours of requests to its addresses from Caddy\'s log, and the share answered 2xx or 3xx', async () => {
  const t = await start();
  try {
    const h = (await t.get(`${API}/vms/web-01/health`, { as: 'naledi-k' })).json;
    assert.deepEqual(h.requests, { total: 48210, okPercent: 99.96 }, 'shop.example.com and blog.example.com, as the mockup says');
    assert.equal((await t.get(`${API}/vms/worker-01/health`, { as: 'naledi-k' })).json.requests, null, 'no endpoint, nothing counted');
    const options = (await t.get(`${API}/apps/-form`, { as: 'priya-s' })).json;
    assert.deepEqual(options.vms.map((v) => `${v.name} ${v.status} ${v.apps}`), ['api-01 running 1', 'docs-01 starting 1', 'staging-01 stopped 1', 'web-01 running 2', 'worker-01 running 1']);
    assert.deepEqual(options.databases.map((d) => d.name), ['analytics', 'catalog', 'orders-db']);
    assert.equal(options.connections[0].id, 'github-stevie');
  } finally {
    await t.close();
  }
});
