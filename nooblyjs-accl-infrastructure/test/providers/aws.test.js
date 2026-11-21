// The AWS adapter (roadmap 2.9, 2.10) against a fake of AWS's APIs (test/fixtures/fake-aws.js), which recomputes every
// request's SigV4 signature. The signer itself is checked against AWS's published example. No real account: the
// sandbox run (INFRA_CLOUD_TESTS=aws) is roadmap 2.9's open half.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../../src/catalog/index.js';
import { createProviders } from '../../src/providers/index.js';
import { missingMethods, hasArea } from '../../src/providers/contract.js';
import { isCloudError } from '../../src/providers/errors.js';
import { awsError, readAwsCredentials } from '../../src/providers/aws/index.js';
import { signRequest } from '../../src/providers/http/sigv4.js';
import { parseXml, items, textOf } from '../../src/providers/http/xml.js';
import { createFakeAws } from '../fixtures/fake-aws.js';

const catalog = await createCatalog();
const LABELS = { 'managed-by': 'noobly-cloud', 'noobly-install': 'nc-test' };
let fake;

before(async () => {
  fake = await createFakeAws({ regions: catalog.forCloud('aws').regions });
});
after(() => fake.close());

async function aws(credentials = fake.role, { base = fake.base, pollMs = 5, accountId = fake.accountId } = {}) {
  const providers = createProviders({ enabled: ['aws'], store: null, secrets: { get: async () => credentials }, catalog, clouds: { aws: { endpoint: fake.endpoint, pollMs, baseCredentials: async () => base } } });
  return providers.forAccount({ id: `acc-${Math.random()}`, cloud: 'aws', provider: 'aws', credentialRef: 'sec_aws', accountId });
}

test('sigv4: reproduces AWS’s published example (IAM ListUsers)', () => {
  // docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (the GET example, signed on 2015-08-30).
  const headers = signRequest({
    method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '', service: 'iam', region: 'us-east-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  const temporary = signRequest({ method: 'POST', url: 'https://sts.amazonaws.com/', body: 'x', service: 'sts', region: 'us-east-1', credentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 'tok' } });
  assert.equal(temporary['x-amz-security-token'], 'tok');
  assert.match(temporary.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
});

test('xml: reads the Query APIs’ answers (sets, entities, CDATA, self-closing)', () => {
  const doc = parseXml('<?xml version="1.0"?><R xmlns="x"><set><item><a>1 &amp; 2</a></item><item><a><![CDATA[<3>]]></a><b/></item></set></R>');
  assert.deepEqual(items(doc, 'set').map((i) => textOf(i, 'a')), ['1 & 2', '<3>']);
  assert.equal(textOf(items(doc, 'set')[1], 'b'), '');
});

test('aws: reads pasted credentials: a role and its external ID, or access keys', () => {
  assert.deepEqual(readAwsCredentials('arn:aws:iam::111122223333:role/noobly-cloud\nnc-ext-1'), { roleArn: 'arn:aws:iam::111122223333:role/noobly-cloud', externalId: 'nc-ext-1', pullRoleArn: null });
  assert.deepEqual(readAwsCredentials({ accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's' }), { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's', sessionToken: null, pullRoleArn: null });
  assert.equal(readAwsCredentials('AKIAABCDEFGHIJKLMNOP abc/def').secretAccessKey, 'abc/def');
  assert.throws(() => readAwsCredentials('arn:aws:iam::12:role/x'), (err) => err.code === 'invalid' && /role ARN looks like/.test(err.message));
  assert.throws(() => readAwsCredentials('hello'), (err) => err.code === 'invalid' && /Paste a role ARN/.test(err.message));
  assert.throws(() => readAwsCredentials('{nope'), /JSON/);
});

test('aws: implements the contract and the registry; assumes the role with the external ID and signs every call', async () => {
  const provider = await aws();
  assert.deepEqual(missingMethods(provider), []);
  assert.equal(hasArea(provider, 'registry'), true);
  assert.deepEqual(await provider.account.verify(), { ok: true, identity: `arn:aws:sts::${fake.accountId}:assumed-role/noobly-cloud/noobly-cloud` });
  assert.ok(fake.state.calls.includes('sts us-east-1 AssumeRole as base'));
  assert.ok(fake.state.calls.includes('sts us-east-1 GetCallerIdentity as role'));
  const assumed = fake.state.assumed.length;
  await provider.account.verify();
  assert.equal(fake.state.assumed.length, assumed, 'the role’s session is kept until five minutes before it ends');

  const direct = await aws(fake.direct, { base: null });
  assert.equal((await direct.account.verify()).ok, true, 'access keys need no role');
});

test('aws: credentials refused, the wrong account, or no server credentials to assume with, are said in words', async () => {
  const wrongExternalId = await (await aws(`arn:aws:iam::${fake.accountId}:role/noobly-cloud\nwrong`)).account.verify();
  assert.equal(wrongExternalId.ok, false);
  assert.match(wrongExternalId.message, /not authorized to perform: sts:AssumeRole/);
  const badSecret = await (await aws({ accessKeyId: 'AKIAFAKEDIRECT000001', secretAccessKey: 'not-it' })).account.verify();
  assert.deepEqual([badSecret.ok, /signature we calculated/.test(badSecret.message)], [false, true]);
  const otherAccount = await (await aws(fake.direct, { accountId: '999999999999' })).account.verify();
  assert.deepEqual(otherAccount, { ok: false, message: `These credentials are for AWS account ${fake.accountId}, not 999999999999.` });
  const noBase = await (await aws(fake.role, { base: null })).account.verify();
  assert.deepEqual([noBase.ok, /AWS_ACCESS_KEY_ID/.test(noBase.message)], [false, true]);
});

test('aws: regions, zones and instance types are the catalogue’s, as the account offers them', async () => {
  const provider = await aws();
  const cat = catalog.forCloud('aws');
  assert.deepEqual((await provider.account.regions()).map((r) => r.id), cat.regions.map((r) => r.id));
  assert.deepEqual(await provider.account.zones('af-south-1'), ['af-south-1a', 'af-south-1b', 'af-south-1c']);
  await assert.rejects(provider.account.zones('mars-north-1'), (err) => err.code === 'invalid');
  assert.deepEqual((await provider.catalog.machineTypes('af-south-1a')).map((t) => t.id), Object.keys(cat.machineTypes), 't3.2xlarge is offered but not in the catalogue');
  assert.deepEqual((await provider.catalog.images()).map((i) => i.id), ['ubuntu-2404-lts', 'ubuntu-2204-lts', 'debian-12'], 'Rocky has no public SSM parameter yet');
});

test('aws: ensureNetwork makes a VPC with DNS hostnames, an internet gateway, a route and a subnet per zone, once', async () => {
  const provider = await aws();
  assert.equal(await provider.account.detectNetwork('af-south-1', { labels: LABELS }), null);
  const first = await provider.account.ensureNetwork('af-south-1', { labels: LABELS });
  assert.deepEqual([first.created, first.operation], [true, null]);
  assert.match(first.ref, /^af-south-1\/vpc-/);
  const vpc = fake.state.vpcs[0];
  assert.deepEqual([vpc.cidr, vpc.dnsHostnames, vpc.tags.Name, vpc.tags['noobly-install']], ['10.128.0.0/16', true, 'noobly-cloud', 'nc-test']);
  assert.equal(fake.state.igws.filter((g) => g.vpc === vpc.id).length, 1);
  assert.ok(fake.state.tables.find((t) => t.vpc === vpc.id).routes.some((r) => r.destinationCidrBlock === '0.0.0.0/0'));
  assert.deepEqual(fake.state.subnets.filter((s) => s.vpc === vpc.id).map((s) => [s.zone, s.cidr]), [['af-south-1a', '10.128.0.0/20'], ['af-south-1b', '10.128.16.0/20'], ['af-south-1c', '10.128.32.0/20']]);
  const again = await provider.account.ensureNetwork('af-south-1', { labels: LABELS });
  assert.deepEqual([again.ref, again.created], [first.ref, false]);
  assert.equal(fake.state.vpcs.length, 1);
  assert.equal(fake.state.igws.length, 1);
  assert.equal(fake.state.subnets.length, 3);
  assert.equal(await provider.account.detectNetwork('af-south-1', { labels: LABELS }), first.ref);
});

test('aws: a VM goes through its life: Elastic IP, launch, security group, stop, start, reboot, metrics, terminate', async () => {
  const provider = await aws();
  const net = await provider.account.ensureNetwork('af-south-1', { labels: LABELS });
  const labels = { ...LABELS, 'noobly-name': 'web-02' };
  const ip = await provider.compute.reserveAddress('af-south-1', { labels });
  assert.match(ip.ref, /^af-south-1\/eipalloc-/);

  const { ref, operation } = await provider.compute.create({ name: 'web-02', zone: 'af-south-1b', machineType: 't3.medium', image: 'ubuntu-2404-lts', diskGb: 30, labels, userData: '#cloud-config\n', address: ip.ref, network: net.ref });
  assert.match(ref, /^af-south-1\/i-/);
  assert.equal((await provider.compute.get(ref)).status, 'provisioning');
  const progress = [];
  await provider.waitFor(operation, { onProgress: (f) => progress.push(f) });
  assert.ok(progress.every((f) => f > 0 && f < 1));
  const sent = fake.state.instances[0];
  assert.equal(sent.userData, '#cloud-config\n', 'user data goes base64-encoded');
  assert.deepEqual([sent.diskGb, sent.imdsv2, sent.tags.Name, sent.zone], [30, 'required', 'web-02', 'af-south-1b']);
  assert.match(sent.ami, /^ami-0/, 'the AMI came from the SSM parameter');
  assert.equal(fake.state.groups.find((g) => g.id === sent.group).name, 'noobly-web-02');

  const vm = await provider.compute.get(ref);
  assert.deepEqual([vm.name, vm.zone, vm.region, vm.machineType, vm.status, vm.publicIp, vm.firewall, vm.labels], ['web-02', 'af-south-1b', 'af-south-1', 't3.medium', 'running', ip.address, [], labels]);
  assert.equal(await provider.compute.defaultAddress(ref), `ec2-${ip.address.replaceAll('.', '-')}.af-south-1.compute.amazonaws.com`, 'the Elastic IP was associated after the launch');

  await provider.compute.setFirewall(ref, [{ port: 22, from: '196.25.1.1/32' }, { port: 443, from: '0.0.0.0/0' }]);
  assert.deepEqual((await provider.compute.get(ref)).firewall, [{ port: 22, from: '196.25.1.1/32' }, { port: 443, from: '0.0.0.0/0' }]);
  await provider.compute.setFirewall(ref, [{ port: 22, from: '41.0.0.0/8' }, { port: 443, from: '0.0.0.0/0' }]);
  assert.deepEqual((await provider.compute.get(ref)).firewall, [{ port: 22, from: '41.0.0.0/8' }, { port: 443, from: '0.0.0.0/0' }], 'only the difference is revoked and authorised');

  await provider.waitFor((await provider.compute.stop(ref)).operation);
  assert.equal((await provider.compute.get(ref)).status, 'stopped');
  assert.deepEqual(await provider.metrics.vm(ref), { window: '1h', cpuPercent: null });
  await assert.rejects(provider.compute.stop(ref), (err) => err.code === 'conflict', 'stopping a stopped instance');
  await provider.waitFor((await provider.compute.start(ref)).operation);
  assert.deepEqual(await provider.compute.restart(ref), { ref, operation: null }, 'a reboot has nothing to wait for');
  assert.equal((await provider.compute.get(ref)).status, 'running');
  assert.deepEqual(await provider.metrics.vm(ref, '24h'), { window: '24h', cpuPercent: 23 });

  assert.deepEqual((await provider.compute.list({ labels })).map((v) => v.name), ['web-02']);
  const inv = await provider.inventory({ labels });
  assert.deepEqual([inv.vms.length, inv.addresses.length, inv.addresses[0].status], [1, 1, 'in-use']);
  assert.equal((await provider.inventory({ labels: LABELS })).networks.length, 1);

  await assert.rejects(provider.compute.create({ name: 'web-02', zone: 'af-south-1a', machineType: 't3.medium', labels, network: net.ref }), (err) => err.code === 'conflict' && /already a VM called web-02/.test(err.message));
  await assert.rejects(provider.compute.create({ name: 'x', zone: 'af-south-1a', machineType: 'n2-huge', network: net.ref }), (err) => err.code === 'invalid');
  await assert.rejects(provider.compute.create({ name: 'x', zone: 'af-south-1a', machineType: 't3.small', image: 'rocky-linux-9', network: net.ref }), (err) => err.code === 'invalid' && /Rocky Linux 9 is not offered on AWS/.test(err.message));
  await assert.rejects(provider.compute.create({ name: 'x', zone: 'eu-west-1a', machineType: 't3.small', labels: { 'noobly-install': 'none' } }), (err) => err.code === 'invalid' && /no Noobly Cloud network in eu-west-1/.test(err.message));

  const group = sent.group;
  await provider.waitFor((await provider.compute.remove(ref)).operation);
  assert.equal(await provider.compute.get(ref), null);
  assert.equal(fake.state.groups.some((g) => g.id === group), false, 'its security group went once it had terminated');
  assert.deepEqual(await provider.compute.remove(ref), { ref, operation: null }, 'removing twice is fine');
  await provider.compute.releaseAddress(ip.ref);
  assert.equal((await provider.inventory({ labels })).addresses.length, 0);
  assert.deepEqual(await provider.compute.releaseAddress(ip.ref), { ref: ip.ref, operation: null });
});

test('aws: ECR: a repository per image, push and pull credentials (from the reader role), list and remove', async () => {
  const provider = await aws();
  const repo = await provider.registry.ensure('af-south-1', { name: 'noobly-builds', labels: { 'managed-by': 'noobly-cloud' } });
  const host = `${fake.accountId}.dkr.ecr.af-south-1.amazonaws.com`;
  assert.deepEqual(repo, { host, path: `${host}/noobly-builds` });
  assert.deepEqual(await provider.registry.ensure('af-south-1', { name: 'noobly-builds' }), repo, 'ensure twice finds it');

  const ref = `${repo.path}/a1b2c3/web:def5678`;
  await provider.registry.prepare(ref);
  await provider.registry.prepare(ref);
  assert.ok(fake.state.repos.has('af-south-1/noobly-builds/a1b2c3/web'), 'the image’s own repository, made once');

  assert.deepEqual(await provider.registry.pushCredentials('af-south-1').then((c) => [c.server, c.username, c.password]), [host, 'AWS', 'push-password']);
  assert.deepEqual(await provider.registry.pullCredentials('af-south-1').then((c) => [c.server, c.username, c.password]), [host, 'AWS', 'pull-password']);
  assert.ok(fake.state.assumed.includes(`arn:aws:iam::${fake.accountId}:role/noobly-pull`));

  fake.state.images.push(
    { region: 'af-south-1', repo: 'noobly-builds/a1b2c3/web', digest: 'sha256:111', tags: ['abc1234'], pushedAt: 1763632800 },
    { region: 'af-south-1', repo: 'noobly-builds/a1b2c3/web', digest: 'sha256:222', tags: ['def5678'], pushedAt: 1763719200 },
  );
  assert.deepEqual((await provider.registry.list(repo.path)).map((i) => [i.ref, i.digest]), [[ref, 'sha256:222'], [`${repo.path}/a1b2c3/web:abc1234`, 'sha256:111']]);
  assert.deepEqual(await provider.registry.remove(`${repo.path}/a1b2c3/web:abc1234`), { ref: `${repo.path}/a1b2c3/web:abc1234`, removed: true });
  assert.equal((await provider.registry.list(repo.path)).length, 1);
  await assert.rejects(provider.registry.remove(`${repo.path}/a1b2c3/web`), (err) => err.code === 'invalid');
  await assert.rejects(provider.registry.list('docker.io/library/node'), (err) => err.code === 'invalid');
});

test('aws: AWS’s error codes become CloudErrors in words', async () => {
  const provider = await aws(fake.direct);
  fake.failNext('DescribeRegions', 503, 'RequestLimitExceeded', 'Request limit exceeded.');
  await assert.rejects(provider.account.regions(), (err) => isCloudError(err) && err.code === 'unavailable');
  fake.failNext('DescribeAvailabilityZones', 403, 'UnauthorizedOperation', 'You are not authorized to perform this operation.');
  await assert.rejects(provider.account.zones('af-south-1'), (err) => err.code === 'permission' && /not authorized/.test(err.message));
  for (const [code, want] of [['InsufficientInstanceCapacity', 'quota'], ['VcpuLimitExceeded', 'quota'], ['IncorrectInstanceState', 'conflict'], ['InvalidInstanceID.NotFound', 'not_found'], ['InvalidParameterValue', 'invalid'], ['AuthFailure', 'permission'], ['ThrottlingException', 'unavailable'], ['RepositoryAlreadyExistsException', 'conflict']]) {
    assert.equal(awsError(400, code, 'm').code, want, code);
  }
  assert.equal(awsError(500, '', '').code, 'unavailable');
});

test('aws: waitFor stops when its signal aborts, and says when AWS stops a new instance', async () => {
  const provider = await aws(fake.direct, { pollMs: 60_000 });
  const net = await provider.account.ensureNetwork('eu-west-1', { labels: LABELS });
  const { operation } = await provider.compute.create({ name: 'slow-01', zone: 'eu-west-1a', machineType: 't3.small', labels: LABELS, network: net.ref });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop')), 100);
  await assert.rejects(provider.waitFor(operation, { signal: controller.signal }), /stop/);

  const quick = await aws(fake.direct);
  const doomed = await quick.compute.create({ name: 'doomed-01', zone: 'eu-west-1a', machineType: 't3.small', labels: LABELS, network: net.ref });
  fake.state.instances.find((v) => v.tags.Name === 'doomed-01').state = 'shutting-down';
  await assert.rejects(quick.waitFor(doomed.operation), (err) => err.code === 'invalid' && /AWS stopped the new instance/.test(err.message));
});
