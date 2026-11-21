// Public HTTPS endpoints (roadmap phase 3; architecture.md §9 "Endpoints") on the mock cloud: the Caddy site files
// they render to, adding one to a running VM (the cloud's address, self-signed) and at launch (a domain), the DNS job
// (Waiting → Verified) and the certificate job (Pending → Valid, with its expiry), several apps on one address by
// path, an uploaded certificate, a site Caddy refuses, changes undone when they fail, removal closing ports 80 and
// 443, a stopped VM's endpoints paused, AWS's DNS name, and who may.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp } from './helpers.js';
import { renderSite, renderSites, mainCaddyfile, siteFile, isEndpointPath } from '../src/remote/caddy.js';

const API = '/infrastructure/api/v1';
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/certs/${name}`, import.meta.url), 'utf8');
const mockVm = async (t, account, name) => (await (await t.hosted.mockCloud(account)).resources((r) => r.kind === 'vm' && r.name === name))[0];
const launch = (over = {}) => ({
  account: 'stevie-prod', name: 'shop-02', region: 'africa-south1', zone: 'africa-south1-a', size: 'small',
  image: 'ubuntu-2404-lts', diskGb: 20, docker: true, sshKeyId: 'key_seedmacbook', sshFrom: 'my-ip', ...over,
});

test('site files: the cloud address on HTTP and HTTPS with tls internal; a domain redirected, or not; paths by length', () => {
  const cloud = renderSite('203.0.113.24', [{ id: 'ep_a1', address: 'cloud', path: '/', port: 3000 }]);
  assert.match(cloud, /^# Written by Noobly Cloud: 1 endpoint on 203\.0\.113\.24/);
  assert.match(cloud, /^http:\/\/203\.0\.113\.24, https:\/\/203\.0\.113\.24 \{$/m);
  assert.match(cloud, /^\ttls internal$/m);
  assert.match(cloud, /^\t\treverse_proxy 127\.0\.0\.1:3000$/m);
  assert.match(cloud, /output file \/var\/log\/caddy\/access\.log/);

  const domain = renderSite('shop.example.com', [
    { id: 'ep_a1', address: 'domain', path: '/', port: 3000, redirectHttp: true, cert: { source: 'letsencrypt' } },
    { id: 'ep_b2', address: 'domain', path: '/blog', port: 8080, redirectHttp: true, cert: { source: 'letsencrypt' } },
  ]);
  assert.match(domain, /^shop\.example\.com \{$/m, 'Caddy redirects HTTP to HTTPS and gets the certificate itself');
  assert.doesNotMatch(domain, /tls /);
  assert.ok(domain.indexOf('handle_path /blog/*') < domain.indexOf('\thandle {'), 'the longer path first');
  assert.match(domain, /redir \/blog \/blog\/ 308/);
  assert.match(domain, /handle_path \/blog\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:8080/);

  const plain = renderSite('shop.example.com', [{ id: 'ep_a1', address: 'domain', path: '/', port: 3000, redirectHttp: false, cert: { source: 'letsencrypt' } }]);
  assert.match(plain, /^http:\/\/shop\.example\.com, https:\/\/shop\.example\.com \{$/m);
  const upload = renderSite('secure.example.com', [{ id: 'ep_c3c3', address: 'domain', path: '/', port: 3000, redirectHttp: true, cert: { source: 'upload' } }]);
  assert.match(upload, /^\ttls \/etc\/caddy\/certs\/ep_c3c3\.crt \/etc\/caddy\/certs\/ep_c3c3\.key$/m);
  // An app's endpoint sends traffic to its current container's port (phase 6 switches it).
  assert.match(renderSite('a.example.com', [{ id: 'ep_d4', address: 'domain', path: '/', port: 3000, upstreamPort: 24123, cert: { source: 'letsencrypt' } }]), /reverse_proxy 127\.0\.0\.1:24123/);

  assert.throws(() => renderSite('shop.example.com; rm -rf /', [{ id: 'ep_a1', path: '/', port: 3000 }]), /Not an address/);
  assert.throws(() => renderSite('shop.example.com', [{ id: 'ep_a1', path: '/../etc', port: 3000 }]), /bad path/);
  assert.throws(() => renderSite('shop.example.com', [{ id: 'ep_a1', path: '/', port: 22 }]), /bad port/);
  assert.throws(() => renderSite('shop.example.com', [{ id: 'ep_a1', path: '/', port: 3000 }, { id: 'ep_b2', path: '/', port: 4000 }]), /routed twice/);
  assert.equal(siteFile('shop.example.com'), 'shop.example.com.caddy');
  assert.ok(isEndpointPath('/docs/v2') && !isEndpointPath('/docs/') && !isEndpointPath('docs') && !isEndpointPath('/a b'));
  assert.deepEqual([...renderSites([{ id: 'ep_a1', host: 'a.example.com', path: '/', port: 1000 }, { id: 'ep_b2', host: 'b.example.com', path: '/', port: 1000, status: 'removing' }]).keys()], ['a.example.com']);
  assert.match(mainCaddyfile({ email: 'ops@example.com' }), /^\temail ops@example\.com$/m);
  assert.throws(() => mainCaddyfile({ email: 'x}\n{' }), /not an email/);
});

test('the cloud address: added to a running VM, it opens 80 and 443, writes one site file, and is live, self-signed', async () => {
  const t = await startApp({ seed: true });
  try {
    assert.ok(!(await mockVm(t, 'stevie-prod', 'worker-01')).firewall.some((r) => r.port === 80), 'no web ports before');
    const res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 9000 } });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual([res.json.endpoint.statusText, res.json.operation.type], ['Configuring', 'endpoint.add']);
    await t.hosted.idle();
    const vm = (await t.get(`${API}/vms/worker-01`, { as: 'naledi-k' })).json;
    const ip = vm.publicIp;
    const [e] = vm.endpoints;
    assert.deepEqual([e.host, e.status, e.cert.text, e.dns.text, e.url, e.httpUrl], [ip, 'active', 'Self-signed', 'Not needed', `https://${ip}`, `http://${ip}`]);
    assert.equal(vm.ports, '22 (my IP only) · 80 · 443');
    const cloudVm = await mockVm(t, 'stevie-prod', 'worker-01');
    assert.deepEqual(cloudVm.firewall.map((r) => `${r.port} ${r.from}`), ['22 196.25.1.10/32', '80 0.0.0.0/0', '443 0.0.0.0/0']);
    assert.deepEqual(Object.keys(cloudVm.caddy.sites), [ip]);
    assert.match(cloudVm.caddy.sites[ip], /tls internal/);
    assert.deepEqual(cloudVm.staged, {}, 'every file sent was taken by its script');
    const op = (await t.get(`${API}/operations/${res.json.operation.id}`, { as: 'stevie' })).json;
    assert.deepEqual(op.steps.map((s) => s.status), ['done', 'skipped', 'done', 'skipped']);
    // The Overview lists it as live.
    const overview = (await t.get(`${API}/summary`, { as: 'stevie' })).json.endpoints.find((x) => x.host === ip);
    assert.deepEqual([overview.text, overview.vm], ['Live · self-signed', 'worker-01']);
    const added = (await t.get(`${API}/activity?kind=vm&limit=3`, { as: 'stevie' })).json.activity.find((a) => a.verb === 'Added');
    assert.equal(added.text, `endpoint ${ip} on worker-01`);
  } finally {
    await t.close();
  }
});

test('a domain at launch: Waiting for its A record, then Verified by the DNS job, then a Let\'s Encrypt certificate', async () => {
  const t = await startApp({ seed: true });
  try {
    const res = await t.post(`${API}/vms`, { as: 'priya-s', body: launch({ endpoint: { enabled: true, address: 'domain', domain: 'Shop2.Example.com', port: 3000 } }) });
    assert.equal(res.status, 202, res.text);
    await t.hosted.idle();
    const op = (await t.get(`${API}/operations/${res.json.operation.id}`, { as: 'stevie' })).json;
    assert.deepEqual(op.steps.map((s) => s.status), ['done', 'done', 'done'], 'the third step is the endpoint');
    let vm = (await t.get(`${API}/vms/shop-02`, { as: 'stevie' })).json;
    let [e] = vm.endpoints;
    assert.deepEqual([e.host, e.status, e.dns.text, e.cert.text, e.url], ['shop2.example.com', 'active', 'Waiting for DNS record', 'Pending', null]);
    assert.deepEqual(e.dns.expect, { type: 'A', name: 'shop2.example.com', value: vm.publicIp }, 'the record to add, once the IP is reserved');
    assert.equal(e.dns.alt, null, 'GCP gives no name to CNAME to');
    assert.equal((await t.get(`${API}/vms`, { as: 'stevie' })).json.vms.find((v) => v.name === 'shop-02').endpoint.note, 'Waiting for DNS');

    // Without the record nothing changes; with it, the DNS job verifies and the certificate job finds Caddy's certificate.
    await t.hosted.runJob('endpoint-dns');
    await t.hosted.runJob('endpoint-certs');
    assert.equal((await t.get(`${API}/vms/shop-02`, { as: 'stevie' })).json.endpoints[0].dns.text, 'Waiting for DNS record');
    await t.hosted.mockDns.set('shop2.example.com', [vm.publicIp]);
    await t.hosted.runJob('endpoint-dns');
    vm = (await t.get(`${API}/vms/shop-02`, { as: 'stevie' })).json;
    assert.deepEqual([vm.endpoints[0].dns.text, vm.endpoints[0].cert.text], ['Verified', 'Pending']);
    await t.hosted.runJob('endpoint-certs');
    [e] = (await t.get(`${API}/vms/shop-02`, { as: 'stevie' })).json.endpoints;
    assert.deepEqual([e.cert.text, e.url], ['Valid', 'https://shop2.example.com']);
    const days = (Date.parse(e.cert.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 89 && days <= 90, `expires in 90 days (${days})`);
    const verbs = (await t.get(`${API}/activity?kind=vm&limit=5`, { as: 'stevie' })).json.activity.map((a) => a.verb);
    assert.ok(verbs.includes('Verified') && verbs.includes('Certificate'), verbs.join(', '));
    const site = (await mockVm(t, 'stevie-prod', 'shop-02')).caddy.sites['shop2.example.com'];
    assert.match(site, /^shop2\.example\.com \{$/m);
  } finally {
    await t.close();
  }
});

test('several apps on one address by path, and a path or address already in use is refused', async () => {
  const t = await startApp({ seed: true });
  try {
    // web-01 already serves shop.example.com and blog.example.com (the seed story).
    let res = await t.post(`${API}/vms/web-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'shop.example.com', path: '/admin/', port: 4000 } });
    assert.equal(res.status, 202, res.text);
    await t.hosted.idle();
    const site = (await mockVm(t, 'stevie-prod', 'web-01')).caddy.sites['shop.example.com'];
    assert.match(site, /2 endpoints on shop\.example\.com/);
    assert.match(site, /handle_path \/admin\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:4000/);
    assert.match(site, /\thandle \{\n\t\treverse_proxy 127\.0\.0\.1:3000/);
    const vm = (await t.get(`${API}/vms/web-01`, { as: 'stevie' })).json;
    const admin = vm.endpoints.find((e) => e.path === '/admin');
    assert.deepEqual([admin.dns.text, admin.cert.text], ['Verified', 'Valid'], 'it shares the address\'s DNS and certificate');

    res = await t.post(`${API}/vms/web-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'shop.example.com', path: '/admin', port: 4001 } });
    assert.deepEqual([res.status, Object.keys(res.json.error.details.fields)], [422, ['path']]);
    res = await t.post(`${API}/vms/api-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'shop.example.com', path: '/x', port: 4001 } });
    assert.equal(res.status, 409);
    assert.match(res.json.error.message, /already in use on web-01/);
    res = await t.post(`${API}/vms/web-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'shop.example.com', path: '/api', port: 4002, redirectHttp: false } });
    assert.deepEqual([res.status, Object.keys(res.json.error.details.fields)], [422, ['cert']], 'one address, one HTTP setting');
  } finally {
    await t.close();
  }
});

test('what is sent is checked field by field; a stopped VM and a busy one are refused; a Viewer may not', async () => {
  const t = await startApp({ seed: true });
  try {
    for (const [body, fields] of [
      [{ address: 'elsewhere', port: 3000 }, ['address']],
      [{ address: 'domain', domain: 'not a domain', port: 3000 }, ['domain']],
      [{ address: 'domain', domain: '203.0.113.9', port: 3000 }, ['domain']],
      [{ address: 'domain', domain: 'ec2-1-2-3-4.af-south-1.compute.amazonaws.com', port: 3000 }, ['domain']],
      [{ address: 'domain', domain: 'x.example.com', port: 22 }, ['port']],
      [{ address: 'domain', domain: 'x.example.com', port: 70000 }, ['port']],
      [{ address: 'domain', domain: 'x.example.com', port: 3000, path: '/../etc' }, ['path']],
      [{ address: 'domain', domain: 'x.example.com', port: 3000, cert: 'self' }, ['cert']],
      [{ address: 'domain', domain: 'x.example.com', port: 3000, cert: 'upload' }, ['certificate', 'privateKey']],
    ]) {
      const res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body });
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.deepEqual(Object.keys(res.json.error.details.fields).sort(), fields.sort(), JSON.stringify(body));
    }
    let res = await t.post(`${API}/vms/staging-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 3000 } });
    assert.equal(res.status, 409);
    assert.match(res.json.error.message, /stopped\. Start it/);
    res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'naledi-k', body: { address: 'cloud', port: 3000 } });
    assert.equal(res.status, 403);
    res = await t.post(`${API}/vms/catalog-db/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 3000 } });
    assert.equal(res.status, 404, 'a database VM has no endpoints');
    // While the first is being configured, the VM is busy.
    await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 3000 } });
    res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 3001, path: '/b' } });
    assert.ok([202, 409].includes(res.status));
    await t.hosted.idle();
    assert.equal((await t.get(`${API}/endpoints?vm=worker-01`, { as: 'naledi-k' })).json.endpoints.length >= 1, true);
    // A stopped VM's endpoints are paused, not gone.
    const staging = (await t.get(`${API}/vms/staging-01`, { as: 'stevie' })).json.endpoints[0];
    assert.deepEqual([staging.note, staging.url, staging.can.change], ['Paused while stopped', null, false]);
    assert.equal((await t.get(`${API}/vms`, { as: 'stevie' })).json.vms.find((v) => v.name === 'staging-01').endpoint.note, 'Paused while stopped');
  } finally {
    await t.close();
  }
});

test('an uploaded certificate: checked against the domain and its key, kept as a secret, installed, and valid until its date', async () => {
  const t = await startApp({ seed: true });
  try {
    const certificate = fixture('secure.crt');
    let res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'wrong.example.com', port: 3000, cert: 'upload', certificate, privateKey: fixture('secure.key') } });
    assert.deepEqual([res.status, res.json.error.details.fields.certificate], [422, 'This certificate is not for wrong.example.com.']);
    res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'secure.example.com', port: 3000, cert: 'upload', certificate, privateKey: fixture('other.key') } });
    assert.deepEqual([res.status, res.json.error.details.fields.privateKey], [422, 'This key does not belong to the certificate.']);
    res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'secure.example.com', port: 3000, cert: 'upload', certificate: 'nope', privateKey: fixture('secure.key') } });
    assert.equal(res.json.error.details.fields.certificate, 'This is not a PEM certificate.');

    res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'secure.example.com', port: 3000, cert: 'upload', certificate, privateKey: fixture('secure.key') } });
    assert.equal(res.status, 202, res.text);
    assert.doesNotMatch(res.text, /PRIVATE KEY/);
    await t.hosted.idle();
    const [e] = (await t.get(`${API}/vms/worker-01`, { as: 'stevie' })).json.endpoints;
    assert.equal(e.cert.text, 'Valid');
    assert.ok(Date.parse(e.cert.expiresAt) > Date.now() + 19 * 365 * 86_400_000);
    const cloudVm = await mockVm(t, 'stevie-prod', 'worker-01');
    assert.equal(cloudVm.caddy.certs[e.id].cert.trim(), certificate.trim());
    assert.match(cloudVm.caddy.sites['secure.example.com'], new RegExp(`tls /etc/caddy/certs/${e.id}\\.crt /etc/caddy/certs/${e.id}\\.key`));
    for (const url of [`${API}/vms/worker-01`, `${API}/endpoints`, `${API}/endpoints/${e.id}`]) assert.doesNotMatch((await t.get(url, { as: 'stevie' })).text, /PRIVATE KEY|BEGIN CERTIFICATE/);
    const files = fs.readdirSync(t.dataDir, { recursive: true }).map(String).filter((f) => f.endsWith('.md') && f.includes('endpoints'));
    for (const f of files) assert.doesNotMatch(fs.readFileSync(`${t.dataDir}/${f}`, 'utf8'), /PRIVATE KEY/, f);
  } finally {
    await t.close();
  }
});

test('a site Caddy refuses fails the endpoint (others keep serving); a failed change is undone; removing the last endpoint closes 80 and 443', async () => {
  const t = await startApp({ seed: true });
  try {
    const cloud = await t.hosted.mockCloud('stevie-prod');
    const ref = (await mockVm(t, 'stevie-prod', 'worker-01')).id;
    await cloud.outOfBand(ref, { caddyRefuses: 'unrecognized directive: oops' });
    let res = await t.post(`${API}/vms/worker-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 3000 } });
    await t.hosted.idle();
    let [e] = (await t.get(`${API}/vms/worker-01`, { as: 'stevie' })).json.endpoints;
    assert.deepEqual([e.status, e.statusText], ['failed', 'Failed']);
    assert.match(e.failure, /Caddy refused it: unrecognized directive: oops/);
    assert.deepEqual(Object.keys((await mockVm(t, 'stevie-prod', 'worker-01')).caddy.sites), []);
    // Trying again by changing it works.
    res = await t.patch(`${API}/endpoints/${e.id}`, { as: 'priya-s', body: { port: 3001 } });
    assert.equal(res.status, 202, res.text);
    await t.hosted.idle();
    [e] = (await t.get(`${API}/vms/worker-01`, { as: 'stevie' })).json.endpoints;
    assert.deepEqual([e.status, e.port, e.failure], ['active', 3001, null]);

    // A change Caddy refuses leaves the endpoint as it was.
    await cloud.outOfBand(ref, { caddyRefuses: 'no' });
    await t.patch(`${API}/endpoints/${e.id}`, { as: 'priya-s', body: { port: 3002, path: '/v2' } });
    await t.hosted.idle();
    [e] = (await t.get(`${API}/vms/worker-01`, { as: 'stevie' })).json.endpoints;
    assert.deepEqual([e.status, e.port, e.path], ['active', 3001, '/']);
    assert.match(e.failure, /Caddy refused/);
    assert.match((await mockVm(t, 'stevie-prod', 'worker-01')).caddy.sites[e.host], /127\.0\.0\.1:3001/);

    res = await t.delete(`${API}/endpoints/${e.id}`, { as: 'priya-s' });
    assert.equal(res.status, 202);
    await t.hosted.idle();
    const after = await mockVm(t, 'stevie-prod', 'worker-01');
    assert.deepEqual([Object.keys(after.caddy.sites), after.firewall.map((r) => r.port)], [[], [22]], 'SSH as launched, nothing else');
    assert.deepEqual((await t.get(`${API}/vms/worker-01`, { as: 'stevie' })).json.endpoints, []);
    assert.equal((await t.get(`${API}/endpoints/${e.id}`, { as: 'stevie' })).status, 404);
  } finally {
    await t.close();
  }
});

test('on AWS the cloud\'s address is the VM\'s public DNS name, and a domain may CNAME to it', async () => {
  const t = await startApp({ seed: true });
  try {
    await t.post(`${API}/vms/api-01/endpoints`, { as: 'priya-s', body: { address: 'cloud', port: 8080, path: '/status' } });
    await t.hosted.idle();
    let vm = (await t.get(`${API}/vms/api-01`, { as: 'stevie' })).json;
    const cloudEp = vm.endpoints.find((e) => e.address === 'cloud');
    assert.match(cloudEp.host, /^ec2-\d+-\d+-\d+-\d+\.af-south-1\.compute\.amazonaws\.com$/);
    assert.equal(cloudEp.url, `https://${cloudEp.host}/status/`);

    await t.post(`${API}/vms/api-01/endpoints`, { as: 'priya-s', body: { address: 'domain', domain: 'orders.example.com', port: 3000 } });
    await t.hosted.idle();
    vm = (await t.get(`${API}/vms/api-01`, { as: 'stevie' })).json;
    let orders = vm.endpoints.find((e) => e.host === 'orders.example.com');
    assert.deepEqual(orders.dns.alt, { type: 'CNAME', name: 'orders.example.com', value: cloudEp.host });
    await t.hosted.mockDns.set('orders.example.com', { cname: cloudEp.host });
    await t.hosted.runJob('endpoint-dns');
    orders = (await t.get(`${API}/vms/api-01`, { as: 'stevie' })).json.endpoints.find((e) => e.host === 'orders.example.com');
    assert.equal(orders.dns.text, 'Verified');
  } finally {
    await t.close();
  }
});
