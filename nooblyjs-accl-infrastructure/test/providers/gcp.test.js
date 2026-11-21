// The GCP adapter (roadmap 2.8, 2.10) against a fake of Google's APIs (test/fixtures/fake-gcp.js): the service
// account's signed JWT, Compute Engine, Cloud Monitoring, Artifact Registry and IAM Credentials. No real project: the
// sandbox run (INFRA_CLOUD_TESTS=gcp) is roadmap 2.8's open half.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../../src/catalog/index.js';
import { createProviders } from '../../src/providers/index.js';
import { missingMethods, hasArea } from '../../src/providers/contract.js';
import { isCloudError } from '../../src/providers/errors.js';
import { googleError } from '../../src/providers/gcp/index.js';
import { createFakeGcp } from '../fixtures/fake-gcp.js';

const catalog = await createCatalog();
const LABELS = { 'managed-by': 'noobly-cloud', 'noobly-install': 'nc-test' };
let fake;

before(async () => {
  fake = await createFakeGcp({ regions: catalog.forCloud('gcp').regions });
});
after(() => fake.close());

async function gcp(credentials = fake.key, { pollMs = 5 } = {}) {
  const providers = createProviders({ enabled: ['gcp'], store: null, secrets: { get: async () => credentials }, catalog, clouds: { gcp: { endpoints: fake.endpoints, pollMs } } });
  return providers.forAccount({ id: `acc-${Math.random()}`, cloud: 'gcp', provider: 'gcp', credentialRef: 'sec_gcp', projectId: fake.project });
}

test('gcp: implements the contract and the registry, and signs in with the service account key', async () => {
  const provider = await gcp(JSON.stringify(fake.key));
  assert.deepEqual(missingMethods(provider), []);
  assert.equal(hasArea(provider, 'registry'), true);
  assert.deepEqual(await provider.account.verify(), { ok: true, identity: `noobly@${fake.project}.iam.gserviceaccount.com on project ${fake.project}` });
  assert.ok(fake.state.tokens.size >= 1, 'a token was traded for the signed JWT');
  const before_ = fake.state.calls.filter((c) => c === 'POST /token').length;
  await provider.account.verify();
  assert.equal(fake.state.calls.filter((c) => c === 'POST /token').length, before_, 'the token is kept until it nearly expires');
});

test('gcp: a key that is not a key, or that Google refuses, is said in words', async () => {
  await assert.rejects(gcp('not json'), (err) => isCloudError(err) && err.code === 'invalid' && /not JSON/.test(err.message));
  await assert.rejects(gcp({ type: 'authorized_user' }), (err) => err.code === 'invalid' && /service account key/.test(err.message));
  // Signed with another key: the fake checks the signature and refuses it.
  const { generateKeyPairSync } = await import('node:crypto');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const refused = await (await gcp({ ...fake.key, private_key: other })).account.verify();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /refused the service account key: Invalid JWT Signature/);
});

test('gcp: regions, zones and machine types are the catalogue’s, as the project offers them', async () => {
  const provider = await gcp();
  const cat = catalog.forCloud('gcp');
  assert.deepEqual((await provider.account.regions()).map((r) => r.id), cat.regions.map((r) => r.id));
  assert.deepEqual(await provider.account.zones('africa-south1'), ['africa-south1-a', 'africa-south1-b', 'africa-south1-c']);
  await assert.rejects(provider.account.zones('mars-north1'), (err) => err.code === 'invalid');
  const types = await provider.catalog.machineTypes('africa-south1-a');
  assert.deepEqual(types.map((t) => t.id), Object.keys(cat.machineTypes), 'e2-standard-8 is offered but not in the catalogue');
  assert.deepEqual(types.find((t) => t.id === 'e2-medium'), { id: 'e2-medium', vcpu: 2, memoryGb: 4 });
  assert.deepEqual((await provider.catalog.images()).map((i) => i.id), cat.images.map((i) => i.id));
});

test('gcp: ensureNetwork makes the network and the region’s subnetwork once', async () => {
  const provider = await gcp();
  assert.equal(await provider.account.detectNetwork('africa-south1'), null);
  const first = await provider.account.ensureNetwork('africa-south1', { labels: LABELS });
  assert.deepEqual([first.ref, first.created], ['regions/africa-south1/subnetworks/noobly-cloud', true]);
  await provider.waitFor(first.operation);
  assert.equal(fake.state.networks.get('noobly-cloud').autoCreateSubnetworks, false);
  assert.equal(fake.state.subnets.get('africa-south1/noobly-cloud').ipCidrRange, '10.128.0.0/20');
  const again = await provider.account.ensureNetwork('africa-south1', { labels: LABELS });
  assert.deepEqual([again.ref, again.created, again.operation], [first.ref, false, null]);
  assert.equal(await provider.account.detectNetwork('africa-south1'), first.ref);
  const other = await provider.account.ensureNetwork('europe-west2', { labels: LABELS });
  await provider.waitFor(other.operation);
  assert.equal(fake.state.subnets.get('europe-west2/noobly-cloud').ipCidrRange, '10.129.0.0/20', 'one /20 per region, by its place in the catalogue');
  assert.equal(fake.state.networks.size, 1);
});

test('gcp: a VM goes through its life: address, create, firewall, stop, start, restart, metrics, remove', async () => {
  const provider = await gcp();
  const net = await provider.account.ensureNetwork('africa-south1', { labels: LABELS });
  await provider.waitFor(net.operation);
  const labels = { ...LABELS, 'noobly-name': 'web-01' };
  const ip = await provider.compute.reserveAddress('africa-south1', { labels });
  assert.match(ip.ref, /^regions\/africa-south1\/addresses\/noobly-web-01-/);
  assert.match(ip.address, /^203\.0\.113\./);

  const progress = [];
  const { ref, operation } = await provider.compute.create({ name: 'web-01', zone: 'africa-south1-a', machineType: 'e2-medium', image: 'ubuntu-2404-lts', diskGb: 30, labels, userData: '#cloud-config\n', address: ip.ref, network: net.ref });
  assert.equal(ref, 'zones/africa-south1-a/instances/web-01');
  assert.equal((await provider.compute.get(ref)).status, 'provisioning');
  await provider.waitFor(operation, { onProgress: (f) => progress.push(f) });
  assert.ok(progress.length >= 1 && progress.every((f) => f > 0 && f < 1));
  const sent = fake.state.instances.get('africa-south1-a/web-01');
  assert.equal(sent.disks[0].initializeParams.sourceImage, 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64');
  assert.equal(sent.disks[0].initializeParams.diskSizeGb, '30');
  assert.deepEqual(sent.metadata.items, [{ key: 'user-data', value: '#cloud-config\n' }]);
  assert.deepEqual(sent.tags.items, ['noobly-web-01']);

  const vm = await provider.compute.get(ref);
  assert.deepEqual({ ...vm, createdAt: undefined }, {
    id: ref, kind: 'vm', name: 'web-01', zone: 'africa-south1-a', region: 'africa-south1', machineType: 'e2-medium', status: 'running',
    publicIp: ip.address, privateIp: '10.128.0.2', firewall: [], labels, instanceId: sent.id, createdAt: undefined,
  });
  assert.equal(await provider.compute.defaultAddress(ref), ip.address, 'GCP gives no hostname: the address is the IP');

  await provider.compute.setFirewall(ref, [{ port: 22, from: '196.25.1.1/32' }, { port: 443, from: '0.0.0.0/0' }, { port: 22, from: '41.0.0.0/8' }]);
  assert.deepEqual([...fake.state.firewalls.keys()].sort(), ['noobly-web-01-22', 'noobly-web-01-443']);
  assert.deepEqual(fake.state.firewalls.get('noobly-web-01-22').targetTags, ['noobly-web-01']);
  assert.deepEqual((await provider.compute.get(ref)).firewall, [{ port: 22, from: '196.25.1.1/32' }, { port: 22, from: '41.0.0.0/8' }, { port: 443, from: '0.0.0.0/0' }]);
  await provider.compute.setFirewall(ref, [{ port: 22, from: '196.25.1.1/32' }]);
  assert.deepEqual((await provider.compute.get(ref)).firewall, [{ port: 22, from: '196.25.1.1/32' }], 'a port no longer wanted loses its rule; a narrowed one is patched');

  await provider.waitFor((await provider.compute.stop(ref)).operation);
  assert.equal((await provider.compute.get(ref)).status, 'stopped');
  assert.deepEqual(await provider.metrics.vm(ref), { window: '1h', cpuPercent: null }, 'a stopped VM has no CPU');
  await provider.waitFor((await provider.compute.start(ref)).operation);
  await provider.waitFor((await provider.compute.restart(ref)).operation);
  assert.equal((await provider.compute.get(ref)).status, 'running');
  assert.deepEqual(await provider.metrics.vm(ref), { window: '1h', cpuPercent: 23 });

  assert.deepEqual((await provider.compute.list({ labels })).map((v) => v.name), ['web-01']);
  assert.deepEqual(await provider.compute.list({ labels: { ...labels, 'noobly-install': 'other' } }), []);
  const inv = await provider.inventory({ labels });
  assert.deepEqual([inv.vms.length, inv.addresses.length, inv.networks.length], [1, 1, 1]);
  assert.equal(inv.addresses[0].status, 'in_use');

  await assert.rejects(provider.compute.create({ name: 'web-01', zone: 'africa-south1-b', machineType: 'e2-medium', labels }), (err) => err.code === 'conflict');
  await assert.rejects(provider.compute.create({ name: 'x', zone: 'africa-south1-a', machineType: 'n2-huge' }), (err) => err.code === 'invalid');
  await assert.rejects(provider.compute.create({ name: 'x', zone: 'mars-1a', machineType: 'e2-medium' }), (err) => err.code === 'invalid');

  await provider.waitFor((await provider.compute.remove(ref)).operation);
  assert.equal(await provider.compute.get(ref), null);
  assert.equal(fake.state.firewalls.size, 0, 'its firewall rules went with it');
  await provider.waitFor((await provider.compute.releaseAddress(ip.ref)).operation);
  assert.equal((await provider.inventory({ labels })).addresses.length, 0);
  assert.deepEqual(await provider.compute.releaseAddress(ip.ref), { ref: ip.ref, operation: null }, 'releasing twice is fine');
});

test('gcp: Artifact Registry: a repository, push and pull credentials, list and remove', async () => {
  const provider = await gcp();
  const repo = await provider.registry.ensure('africa-south1', { name: 'noobly-builds', labels: { 'managed-by': 'noobly-cloud' } });
  assert.deepEqual(repo, { host: 'africa-south1-docker.pkg.dev', path: `africa-south1-docker.pkg.dev/${fake.project}/noobly-builds` });
  assert.deepEqual(await provider.registry.ensure('africa-south1', { name: 'noobly-builds' }), repo, 'ensure twice finds it');
  await assert.rejects(provider.registry.ensure('africa-south1', { name: 'Bad_Name' }), (err) => err.code === 'invalid');

  const push = await provider.registry.pushCredentials('africa-south1');
  assert.equal(push.username, 'oauth2accesstoken');
  assert.ok(fake.state.tokens.has(push.password), 'pushes use the service account’s own token');
  const pull = await provider.registry.pullCredentials('africa-south1');
  assert.deepEqual([pull.server, pull.username, pull.password], ['africa-south1-docker.pkg.dev', 'oauth2accesstoken', 'ya29.reader'], 'pulls use the reader account');

  fake.state.images.push(
    { region: 'africa-south1', repo: 'noobly-builds', pkg: 'a1b2c3/web', digest: 'sha256:111', tags: ['abc1234'], uploadTime: '2026-11-20T10:00:00Z' },
    { region: 'africa-south1', repo: 'noobly-builds', pkg: 'a1b2c3/web', digest: 'sha256:222', tags: ['def5678', 'latest'], uploadTime: '2026-11-21T10:00:00Z' },
  );
  const listed = await provider.registry.list(repo.path);
  assert.deepEqual(listed.map((i) => [i.ref, i.digest]), [
    [`${repo.path}/a1b2c3/web:def5678`, 'sha256:222'], [`${repo.path}/a1b2c3/web:latest`, 'sha256:222'], [`${repo.path}/a1b2c3/web:abc1234`, 'sha256:111'],
  ]);
  assert.deepEqual(await provider.registry.remove(`${repo.path}/a1b2c3/web:abc1234`), { ref: `${repo.path}/a1b2c3/web:abc1234`, removed: true });
  assert.deepEqual(await provider.registry.remove(`${repo.path}/a1b2c3/web:abc1234`), { ref: `${repo.path}/a1b2c3/web:abc1234`, removed: false });
  assert.equal((await provider.registry.list(repo.path)).length, 2);
  await assert.rejects(provider.registry.list('docker.io/library/node'), (err) => err.code === 'invalid');
});

test('gcp: Google’s errors become CloudErrors in words', async () => {
  const provider = await gcp();
  fake.failNext('GET', /\/regions$/, 403, 'Required permission compute.regions.list', 'forbidden');
  await assert.rejects(provider.account.regions(), (err) => err.code === 'permission' && /compute\.regions\.list/.test(err.message));
  fake.failNext('GET', /\/regions$/, 503, 'backend', 'backendError');
  await assert.rejects(provider.account.regions(), (err) => err.code === 'unavailable');
  fake.failNext('GET', /^\/compute\/v1\/projects\/[^/]+$/, 404, 'The resource was not found', 'notFound');
  assert.deepEqual(await provider.account.verify(), { ok: false, message: `There is no project ${fake.project}, or the service account can’t see it.` });
  assert.equal(googleError(403, { error: { message: 'Quota CPUS exceeded', errors: [{ reason: 'quotaExceeded' }] } }).code, 'quota');
  assert.equal(googleError(400, { error: { message: 'x', status: 'ZONE_RESOURCE_POOL_EXHAUSTED' } }).code, 'quota');
  assert.equal(googleError(409, {}).code, 'conflict');
  assert.equal(googleError(401, {}).code, 'permission');
  assert.equal(googleError(400, { error: { message: 'Invalid value' } }).message, 'Google Cloud: Invalid value');
});

test('gcp: waitFor reports progress and stops when its signal aborts', async () => {
  const provider = await gcp(fake.key, { pollMs: 60_000 });
  const ip = await (await gcp()).compute.reserveAddress('us-central1', { labels: LABELS });
  const { operation } = await provider.compute.releaseAddress(ip.ref);
  const seen = [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop')), 100);
  await assert.rejects(provider.waitFor(operation, { signal: controller.signal, onProgress: (f) => seen.push(f) }), /stop/);
  assert.deepEqual(seen, [0.5]);
});
