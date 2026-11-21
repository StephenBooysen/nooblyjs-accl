// Ingress, rolling deploys and idle sleep (spec 8.4), offline on the mock cloud. An ingress pool's VM (a mock agent with
// a mock Caddy) serves each web workload under the platform domain, balancing over its instances on two hosts; a test
// client sends requests through it while the workload deploys, scales and changes plan, and none fails. A failed
// health check keeps the old version. Custom domains are served once their DNS points at the ingress, with on-demand
// TLS only for them. Hosts take instance ports only from the ingress. Requests and bytes are counted per workload. A
// service with no requests goes to sleep and the next request wakes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { caddyConfig, parseMetrics } from '../agent/ingress.js';
import { checkCommand } from '../agent/protocol.js';

// Ingress VMs call this controller's hooks (on-demand TLS, wake) at its public address.
process.env.INFRA_PUBLIC_URL = 'https://cloud.example.com';

const API = '/infrastructure/api/v1/platform';
const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const HOST = 'shop-acme.nooblyjs.app';
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
  source: { repo: 'https://github.com/acme/shop', branch: 'main' }, build: { runtime: 'node22' },
  run: { port: 3000 }, plan: { cpu: 0.25, memoryMb: 256 }, instances: 2, healthCheck: { path: '/healthz' }, ...over,
});

test('8.4.3 the agent renders sites as Caddy JSON: health checks that drop a dead instance within 10 s, retries, wildcard, on-demand TLS', () => {
  const cfg = caddyConfig({
    sites: [
      { id: 'acme-shop', hosts: ['shop-acme.nooblyjs.app', 'shop.acme.example'], upstreams: ['10.10.0.3:20001', '10.10.0.2:20000'], health: { path: '/healthz' } },
      { id: 'acme-blog', hosts: ['blog-acme.nooblyjs.app'], upstreams: [], health: { path: '/' } },
      { id: 'acme-docs', hosts: ['docs-acme.nooblyjs.app'], upstreams: ['10.10.0.2:20002'], sleeping: true },
    ],
    wildcard: { domain: 'nooblyjs.app', provider: 'googleclouddns', project: 'acme-prod' },
    ask: 'https://cloud.example.com/infrastructure/hooks/platform/tls-ask',
    wake: 'https://cloud.example.com/infrastructure/hooks/platform/wake',
  });
  const server = cfg.apps.http.servers.noobly;
  const [blog, docs, shop, fallback] = server.routes;
  assert.deepEqual(shop.match, [{ host: ['shop-acme.nooblyjs.app', 'shop.acme.example'] }]);
  const proxy = shop.handle[0];
  assert.deepEqual(proxy.upstreams, [{ dial: '10.10.0.2:20000' }, { dial: '10.10.0.3:20001' }]);
  assert.deepEqual(proxy.health_checks.active, { uri: '/healthz', interval: '2s', timeout: '2s', passes: 1, fails: 2 }, 'out of rotation after two failed checks 2 s apart');
  assert.equal(proxy.load_balancing.try_duration, '5s', 'a request that meets a dead instance is tried on another');
  assert.equal(blog.handle[0].status_code, 503);
  assert.equal(docs.handle[0].status_code, 307);
  assert.match(docs.handle[0].headers.Location[0], /^https:\/\/cloud\.example\.com\/infrastructure\/hooks\/platform\/wake\?host=\{http\.request\.host\}/);
  assert.equal(fallback.handle[0].status_code, 404);
  assert.deepEqual(server.automatic_https, { prefer_wildcard: true });
  assert.deepEqual(server.metrics, { per_host: true });
  assert.deepEqual(cfg.apps.tls.certificates.automate, ['*.nooblyjs.app']);
  assert.deepEqual(cfg.apps.tls.automation.policies[0].issuers[0].challenges.dns.provider, { name: 'googleclouddns', gcp_project: 'acme-prod' });
  assert.equal(cfg.apps.tls.automation.on_demand.permission.endpoint, 'https://cloud.example.com/infrastructure/hooks/platform/tls-ask');
  assert.equal(cfg.admin.listen, '127.0.0.1:2019', 'the admin API never leaves the VM');

  // What the controller may send is checked first: no raw config, no public upstreams, no odd host names.
  const paths = (a) => checkCommand('ingress.sync', a).map((p) => p.path);
  const site = { id: 'acme-shop', hosts: ['shop-acme.nooblyjs.app'], upstreams: ['10.10.0.2:20000'] };
  assert.deepEqual(paths({ sites: [site] }), []);
  assert.deepEqual(paths({ sites: [{ ...site, hosts: ['evil.com/x'], upstreams: ['10.10.0.2:22', '169.254.169.254:80'] }] }), ['args.sites.0.hosts.0', 'args.sites.0.upstreams.0', 'args.sites.0.upstreams.1']);
  assert.deepEqual(paths({ sites: [{ ...site, caddyfile: 'import /etc/*' }] }), ['args.sites.0.caddyfile']);

  const metrics = [
    '# TYPE caddy_http_requests_total counter',
    'caddy_http_requests_total{handler="reverse_proxy",host="shop-acme.nooblyjs.app",server="noobly"} 12',
    'caddy_http_response_size_bytes_sum{code="200",handler="reverse_proxy",host="shop-acme.nooblyjs.app",method="GET",server="noobly"} 6144',
    'caddy_http_request_duration_seconds_count{code="502",handler="reverse_proxy",host="shop-acme.nooblyjs.app",method="GET",server="noobly"} 1',
    'caddy_http_requests_total{handler="reverse_proxy",host="other",server="srv1"} 99',
  ].join('\n');
  assert.deepEqual(parseMetrics(metrics), { 'shop-acme.nooblyjs.app': { requests: 12, bytesOut: 6144, errors: 1 } });
});

async function start() {
  const app = await startApp({ seed: true, platform: { enabled: true, domain: 'nooblyjs.app' }, local: { drainMs: 0 }, agents: { checkMs: 0 } });
  const t = app;
  for (const body of [
    { name: 'web', account: 'stevie-prod', region: 'africa-south1', size: 'medium', min: 2, max: 3 },
    { name: 'edge', purpose: 'ingress', account: 'stevie-prod', region: 'africa-south1', size: 'small', min: 1, max: 2 },
  ]) assert.equal((await t.post(`${API}/pools`, { as: 'stevie', body })).status, 201);
  await app.hosted.idle();
  const pools = app.hosted.pools;
  return { app, t, pools, platform: app.hosted.services.platform, runtime: app.hosted.local.runtime, edge: pools.mockAgent('edge-1').docker };
}

test('8.4.1, 8.4.3, 8.4.6 a web service answers on its platform name through the ingress, balanced over two hosts; hosts take instance ports only from the ingress', async () => {
  const { app, t, pools, platform, runtime, edge } = await start();
  try {
    await platform.workloads.create('acme', service('shop'), { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'shop')).status, 'live');
    assert.deepEqual((await platform.workloads.hosts('acme', 'shop')).platform, [HOST]);

    const site = edge.ingress.sites.find((s) => s.hosts.includes(HOST));
    assert.equal(site.upstreams.length, 2);
    assert.deepEqual(site.health, { path: '/healthz' });
    assert.deepEqual(edge.ingress.wildcard, { domain: 'nooblyjs.app', provider: 'googleclouddns' });
    const servers = new Set((await runtime.list()).map((i) => i.server));
    assert.equal(servers.size, 2, 'one instance on each host');
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      const r = edge.request(HOST);
      assert.equal(r.status, 200);
      seen.add(r.container);
    }
    assert.equal(seen.size, 2, 'requests go to both instances');
    assert.equal(edge.request('nothing.nooblyjs.app').status, 404);

    // A dead container: requests skip it at once, and it leaves the config when the runtime hears of it.
    const [victim] = await runtime.list();
    const docker = (await t.get(`${API}/pools/web`, { as: 'stevie' })).json.hosts.find((h) => h.server === victim.server).vm;
    for (let i = 0; i < 6; i += 1) pools.mockAgent(docker).docker.crash(victim.name, 137);
    for (let i = 0; i < 4; i += 1) assert.equal(edge.request(HOST).status, 200);
    await runtime.statsNow(victim.server);
    assert.ok(await until(() => edge.ingress.sites.find((s) => s.hosts.includes(HOST)).upstreams.length === 1), 'out of rotation');

    // The firewall: instance ports from the ingress VM's private address only; 80 and 443 open on the ingress VM.
    const cloud = await app.hosted.mockCloud('stevie-prod');
    const vms = await cloud.resources((r) => r.kind === 'vm');
    const edgeVm = (await t.get(`${API}/pools/edge`, { as: 'stevie' })).json.hosts[0];
    for (const name of ['web-1', 'web-2']) {
      const rules = vms.find((v) => v.name === name).firewall;
      assert.deepEqual(rules.filter((r) => r.why === 'ingress'), [{ port: 20000, toPort: 29999, from: `${edgeVm.privateIp}/32`, why: 'ingress' }], name);
      assert.ok(!rules.some((r) => r.port === 443), name);
    }
    assert.deepEqual(vms.find((v) => v.name === 'edge-1').firewall.filter((r) => r.why === 'https').map((r) => r.port), [80, 443]);

    // The Platform screen's data: the region's ingress, its address and last sync.
    const [view] = await app.hosted.ingress.view();
    assert.equal(view.region, 'africa-south1');
    assert.equal(view.online, 1);
    assert.equal(view.addresses.length, 1);
    assert.equal(view.state.error, null);
  } finally {
    await app.close();
  }
});

test('8.4.4 rolling deploy, scale and plan change with zero failed requests; a failed health check keeps the old version', async () => {
  const { app, platform, runtime, pools, edge } = await start();
  try {
    await platform.workloads.create('acme', service('shop'), { actor, commit: 'aaaaaaa' });
    await app.hosted.idle();
    const failures = [];
    let sent = 0;
    const load = setInterval(() => {
      for (let i = 0; i < 3; i += 1) {
        const r = edge.request(HOST);
        sent += 1;
        if (r.status !== 200) failures.push(r.status);
      }
    }, 1);
    try {
      // A deploy: one at a time.
      await platform.workloads.deploy('acme', 'shop', { commit: 'bbbbbbb', actor });
      await app.hosted.idle();
      const [deploy] = (await platform.deploys.list('acme', 'shop')).deploys;
      const text = (await platform.deploys.get('acme', 'shop', deploy.id)).log.map((l) => l.text).join('\n');
      assert.match(text, /Started \S+ on web-\d \(1 of 2\)[\s\S]*is in rotation[\s\S]*Took \S+ out of rotation and stopped it[\s\S]*\(2 of 2\)[\s\S]*Replaced 2 old instances, one at a time/);
      assert.ok((await runtime.list()).every((i) => i.image.endsWith(':bbbbbbb')));

      // A count change adds one without touching the others.
      const before = (await runtime.list()).map((i) => i.name).sort();
      await platform.workloads.scale('acme', 'shop', { instances: 3 }, { actor });
      await app.hosted.idle();
      const after = (await runtime.list()).map((i) => i.name);
      assert.equal(after.length, 3);
      assert.ok(before.every((n) => after.includes(n)), 'the two already running were left alone');

      // A plan change rolls every instance over.
      await platform.workloads.scale('acme', 'shop', { plan: { cpu: 0.5, memoryMb: 512 } }, { actor });
      await app.hosted.idle();
      const resized = await runtime.list();
      assert.equal(resized.length, 3);
      assert.ok(resized.every((i) => i.memoryMb === 512 && !after.includes(i.name)));

      // A health check that fails on the second new instance: the first new one goes, the old version comes back.
      for (const vm of ['web-1', 'web-2', 'web-3']) pools.mockAgent(vm)?.docker.failNext('health.check', 'connection refused', { after: 1 });
      await platform.workloads.deploy('acme', 'shop', { commit: 'ccccccc', actor });
      await app.hosted.idle();
      const [failed] = (await platform.deploys.list('acme', 'shop')).deploys;
      assert.equal(failed.result, 'failed');
      const now_ = await runtime.list();
      assert.equal(now_.filter((i) => i.status === 'running').length, 3);
      assert.ok(now_.every((i) => i.image.endsWith(':bbbbbbb')), 'every instance runs the old version');
      assert.equal((await platform.workloads.get('acme', 'shop')).current.image.endsWith(':bbbbbbb'), true);
    } finally {
      clearInterval(load);
    }
    assert.ok(sent > 100, `the load ran (${sent} requests)`);
    assert.deepEqual(failures, [], `${failures.length} of ${sent} requests failed`);
  } finally {
    await app.close();
  }
});

test('8.4.5 a custom domain is served once its DNS points at the ingress; on-demand TLS answers yes only for it', async () => {
  const { app, t, platform, edge } = await start();
  try {
    await platform.workloads.create('acme', service('shop', { domains: ['shop.acme.example'] }), { actor });
    await app.hosted.idle();
    const ask = (domain) => fetch(`${app.base}/infrastructure/hooks/platform/tls-ask?domain=${encodeURIComponent(domain)}`).then((r) => r.status);
    assert.deepEqual((await platform.workloads.hosts('acme', 'shop')), { platform: [HOST], custom: ['shop.acme.example'] });
    await app.hosted.runJob('ingress-domains');
    assert.equal(edge.request('shop.acme.example').status, 404, 'not served before its DNS is right');
    assert.equal(await ask('shop.acme.example'), 404);
    assert.equal(await ask(HOST), 200, 'the platform name (no sign-in needed)');
    assert.equal(await ask('evil.example'), 404);

    const [address] = await app.hosted.ingress.addresses('africa-south1');
    await app.hosted.mockDns.set(HOST, [address]);
    await app.hosted.mockDns.set('shop.acme.example', { cname: HOST });
    await app.hosted.runJob('ingress-domains');
    const { domains } = await app.hosted.ingress.domainState();
    assert.equal(domains['shop.acme.example'].status, 'verified');
    assert.equal(edge.request('shop.acme.example').status, 200);
    assert.equal(await ask('shop.acme.example'), 200);
    const events = (await t.get('/infrastructure/api/v1/activity?limit=10', { as: 'stevie' })).json.activity.map((a) => a.text);
    assert.ok(events.some((e) => /shop\.acme\.example/.test(e)), events.join(' | '));

    // Removed from the workload: no longer served, no certificate.
    await platform.workloads.update('acme', 'shop', { domains: [] }, { actor });
    await app.hosted.runJob('ingress-domains');
    assert.equal(edge.request('shop.acme.example').status, 404);
    assert.equal(await ask('shop.acme.example'), 404);
  } finally {
    await app.close();
  }
});

test('8.4.7–8.4.8 requests and bytes are counted per workload; an idle service sleeps, and a request wakes it', async () => {
  const { app, platform, edge } = await start();
  try {
    await platform.workloads.create('acme', service('shop', { sleep: { afterMin: 15 } }), { actor });
    await app.hosted.idle();
    for (let i = 0; i < 7; i += 1) edge.request(HOST, '/', { bytes: 1000 });
    await app.hosted.runJob('ingress-traffic');
    let traffic = await platform.workloads.traffic('acme', 'shop');
    assert.deepEqual([traffic.requests, traffic.bytesOut, traffic.errors], [7, 7000, 0]);
    for (let i = 0; i < 3; i += 1) edge.request(HOST, '/', { bytes: 1000 });
    await app.hosted.runJob('ingress-traffic');
    traffic = await platform.workloads.traffic('acme', 'shop');
    assert.equal(traffic.requests, 10, 'counted once each across two collections');
    assert.ok(traffic.lastRequestAt);

    // Not idle yet; then 16 minutes later it is.
    const layer = app.hosted.platformLayer;
    const last = async () => traffic.lastRequestAt;
    assert.deepEqual(await layer.sleepIdle(last), { slept: 0 });
    assert.deepEqual(await layer.sleepIdle(last, { at: Date.now() + 16 * 60_000, canWake: async () => false }), { slept: 0 }, 'nothing sleeps where nothing could wake it');
    assert.deepEqual(await layer.sleepIdle(last, { at: Date.now() + 16 * 60_000, canWake: (r) => app.hosted.ingress.has(r) }), { slept: 1 });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'shop')).status, 'sleeping');
    assert.equal((await app.hosted.local.runtime.list()).filter((i) => i.status === 'running').length, 0, 'nothing runs while it sleeps');
    assert.ok(await until(() => edge.ingress.sites.find((s) => s.hosts.includes(HOST))?.sleeping === true));

    // A visitor: the ingress sends them to the wake hook, which starts it and sends them back.
    const r = edge.request(HOST, '/cart');
    assert.equal(r.status, 307);
    assert.match(r.location, /\/hooks\/platform\/wake\?host=shop-acme\.nooblyjs\.app&path=\/cart$/);
    const woke = await fetch(`${app.base}/infrastructure/hooks/platform/wake?host=${HOST}&path=/cart`, { redirect: 'manual' });
    assert.equal(woke.status, 307);
    assert.equal(woke.headers.get('location'), `https://${HOST}/cart`);
    assert.equal((await platform.workloads.get('acme', 'shop')).status, 'live');
    assert.ok(await until(() => edge.request(HOST).status === 200));
    assert.equal((await fetch(`${app.base}/infrastructure/hooks/platform/wake?host=nope.nooblyjs.app&path=/`, { redirect: 'manual' })).status, 404);

    // Only a web service may sleep.
    const worker = { ...service('q', { kind: 'worker', sleep: { afterMin: 15 } }), run: {} };
    delete worker.healthCheck;
    await assert.rejects(platform.workloads.create('acme', worker, { actor }), (err) => err.details?.fields?.sleep === 'Only a web service sleeps: it has an ingress in front of it to hold the next request.');
  } finally {
    await app.close();
  }
});
