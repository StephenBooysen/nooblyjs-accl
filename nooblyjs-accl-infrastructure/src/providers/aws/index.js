// The AWS provider (architecture.md §6.2; roadmap 2.9, 2.10, spec 8.3.3): the provider contract over AWS's HTTPS APIs,
// signed with SigV4, and no SDK: EC2 (VPC, subnets, internet gateway, security groups, instances, Elastic IPs),
// STS (who the credentials are; AssumeRole with an external ID), SSM (the current AMI for an image), CloudWatch (CPU)
// and ECR (images).
//
// - Credentials: a role to assume (role ARN and external ID, assumed with this server's own AWS credentials), or
//   access keys. The role is assumed again five minutes before its session ends.
// - Refs carry their region, since EC2 is regional: af-south-1/i-0abc, af-south-1/eipalloc-0abc, af-south-1/vpc-0abc.
// - One VPC per region, tagged with the install's labels, 10.<128+i>.0.0/16, DNS hostnames on (so a VM has its public
//   DNS name), an internet gateway and a /20 subnet per availability zone. ensureNetwork completes what is missing.
// - Each VM has its own security group, `noobly-<name>`; setFirewall makes its inbound rules match.
// - Long work returns { kind: 'aws', region, instance, until, allocation?, group? }; waitFor polls the instance's state,
//   then associates its Elastic IP (after a launch) or deletes its security group (after termination).
// - Registry: pushes use these credentials; pulls a token from the reader role `noobly-pull` (or `pullRoleArn`), so
//   hosts can only read (docs/least-privilege.md).
import { CloudError } from '../errors.js';
import { hasLabels } from '../contract.js';
import { signRequest } from '../http/sigv4.js';
import { parseXml, at, textOf, items, children } from '../http/xml.js';

const EC2_VERSION = '2016-11-15';
const LIVE_STATES = ['pending', 'running', 'stopping', 'stopped'];
const STATUS = { pending: 'provisioning', running: 'running', stopping: 'stopping', 'shutting-down': 'deleting', stopped: 'stopped' };
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});
const defaultEndpoint = (service, region) => (service === 'ecr' ? `https://api.ecr.${region}.amazonaws.com/` : `https://${service}.${region}.amazonaws.com/`);

/** Reads pasted AWS credentials. → { roleArn, externalId } or { accessKeyId, secretAccessKey, sessionToken? } */
export function readAwsCredentials(credentials) {
  let c = credentials;
  if (typeof c === 'string') {
    const text = c.trim();
    if (text.startsWith('{')) {
      try {
        c = JSON.parse(text);
      } catch {
        throw new CloudError('invalid', 'The credentials look like JSON but are not.');
      }
    } else {
      const [first = '', second = ''] = text.split(/\s+/);
      c = first.startsWith('arn:') ? { roleArn: first, externalId: second || null } : { accessKeyId: first, secretAccessKey: second };
    }
  }
  if (c?.roleArn) {
    if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(c.roleArn)) throw new CloudError('invalid', 'The role ARN looks like arn:aws:iam::123456789012:role/noobly-cloud.');
    return { roleArn: c.roleArn, externalId: c.externalId ?? null, pullRoleArn: c.pullRoleArn ?? null };
  }
  if (!/^(AKIA|ASIA)[A-Z0-9]{12,20}$/.test(c?.accessKeyId ?? '') || !c?.secretAccessKey) {
    throw new CloudError('invalid', 'Paste a role ARN and its external ID (one per line), or an access key ID and secret access key.');
  }
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken ?? null, pullRoleArn: c.pullRoleArn ?? null };
}

/** AWS's error code and message as a CloudError. */
export function awsError(status, code = '', message = '') {
  const said = message ? `AWS: ${message}` : null;
  if (/^(RequestLimitExceeded|Throttling|ThrottlingException|ServiceUnavailable|Unavailable|InternalError|InternalFailure)$/.test(code)) return new CloudError('unavailable', said ?? 'AWS is busy. It will be tried again.');
  if (/^(UnauthorizedOperation|AuthFailure|AccessDenied|AccessDeniedException|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|UnrecognizedClientException|OptInRequired)/.test(code)) return new CloudError('permission', said ?? 'The credentials are missing a permission.');
  if (/NotFound|NoSuch|ParameterNotFound/.test(code)) return new CloudError('not_found', said ?? 'AWS has no such resource.');
  if (/LimitExceeded|InsufficientInstanceCapacity|InsufficientAddressCapacity|InsufficientCapacity/.test(code)) return new CloudError('quota', said ?? 'The account has reached a quota.');
  if (/AlreadyExists|Duplicate|InUse|IncorrectState|IncorrectInstanceState|DependencyViolation/.test(code)) return new CloudError('conflict', said ?? 'AWS says that is in use.');
  if (status >= 500) return new CloudError('unavailable', `AWS is not answering (${status}).`);
  return new CloudError('invalid', said ?? `AWS refused the request (${code || status}).`);
}

/**
 * @param {object} o
 * @param {object} o.account       the account record (accountId)
 * @param {*} o.credentials        a role ARN and external ID, or access keys
 * @param {object} o.catalog       AWS's catalogue
 * @param {() => Promise<object|null>} [o.baseCredentials]   this server's own AWS credentials, to assume a role with
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(service: string, region: string) => string} [o.endpoint]   API URLs (tests point them at a fake)
 * @param {number} [o.pollMs]
 * @param {() => number} [o.now]
 */
export function createAwsProvider({ account, credentials, catalog, baseCredentials = async () => null, fetchImpl = fetch, endpoint = defaultEndpoint, pollMs = 3000, now = () => Date.now() }) {
  const given = readAwsCredentials(credentials);
  const STS_REGION = 'us-east-1';
  let session = null;
  let accountId = account.accountId ?? (given.roleArn ? given.roleArn.split(':')[4] : null);

  async function send(service, region, { body, headers }, creds) {
    const url = endpoint(service, region);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: signRequest({ method: 'POST', url, headers, body, service, region, credentials: creds, date: new Date(now()) }), body });
    } catch {
      throw new CloudError('unavailable', 'AWS is not answering.');
    }
    return { status: res.status, text: await res.text() };
  }

  /** A Query API call (EC2, STS, CloudWatch): form in, XML out. */
  async function query(service, region, action, params = {}, { version = EC2_VERSION, creds } = {}) {
    const form = new URLSearchParams({ Action: action, Version: version });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
    const { status, text } = await send(service, region, { body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } }, creds ?? await current());
    const xml = parseXml(text);
    if (status >= 400) {
      const err = at(xml, 'Errors', 'Error') ?? at(xml, 'Error') ?? xml;
      throw awsError(status, textOf(err, 'Code') ?? '', textOf(err, 'Message') ?? '');
    }
    return xml;
  }

  /** A JSON API call (SSM, ECR). */
  async function json(service, region, target, payload = {}, { creds } = {}) {
    const { status, text } = await send(service, region, { body: JSON.stringify(payload), headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target } }, creds ?? await current());
    const data = text ? JSON.parse(text) : {};
    if (status >= 400) throw awsError(status, String(data.__type ?? '').split('#').pop(), data.message ?? data.Message ?? '');
    return data;
  }

  async function assume(roleArn, externalId, base) {
    const xml = await query('sts', STS_REGION, 'AssumeRole', { RoleArn: roleArn, RoleSessionName: 'noobly-cloud', DurationSeconds: 3600, ...(externalId ? { ExternalId: externalId } : {}) }, { version: '2011-06-15', creds: base });
    const c = at(xml, 'AssumeRoleResult', 'Credentials');
    return { accessKeyId: textOf(c, 'AccessKeyId'), secretAccessKey: textOf(c, 'SecretAccessKey'), sessionToken: textOf(c, 'SessionToken'), expiresAt: Date.parse(textOf(c, 'Expiration')) };
  }

  /** The credentials to sign with now: the keys given, or the role's session (renewed five minutes early). */
  async function current() {
    if (!given.roleArn) return given;
    if (session && session.expiresAt - 300_000 > now()) return session;
    const base = await baseCredentials();
    if (!base?.accessKeyId) throw new CloudError('permission', 'This server has no AWS credentials of its own to assume the role with. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for it.');
    session = await assume(given.roleArn, given.externalId, base);
    return session;
  }

  // ------------------------------------------------------------------ helpers

  const regionInfo = (id) => {
    const r = catalog.regions.find((x) => x.id === id);
    if (!r) throw new CloudError('invalid', `${catalog.short} has no region ${id} here.`);
    return r;
  };
  const regionOfZone = (zone) => catalog.regions.find((r) => r.zones.includes(zone)) ?? null;
  const split = (ref) => {
    const i = String(ref ?? '').indexOf('/');
    if (i < 1) throw new CloudError('invalid', `${ref} is not an AWS reference.`);
    return [ref.slice(0, i), ref.slice(i + 1)];
  };
  const octet = (region) => 128 + catalog.regions.findIndex((r) => r.id === region);
  /** Filter.N params: tags from labels, plus others ({ 'vpc-id': ['vpc-1'] }). */
  function filters(labels = {}, more = {}) {
    const out = {};
    let n = 0;
    const add = (name, values) => {
      n += 1;
      out[`Filter.${n}.Name`] = name;
      values.forEach((v, i) => { out[`Filter.${n}.Value.${i + 1}`] = v; });
    };
    for (const [k, v] of Object.entries(labels)) if (v !== undefined && v !== null) add(`tag:${k}`, [v]);
    for (const [k, v] of Object.entries(more)) add(k, Array.isArray(v) ? v : [v]);
    return out;
  }
  /** TagSpecification.N params for a resource type. */
  function tagSpec(n, type, tags) {
    const out = { [`TagSpecification.${n}.ResourceType`]: type };
    Object.entries(tags).forEach(([k, v], i) => {
      out[`TagSpecification.${n}.Tag.${i + 1}.Key`] = k;
      out[`TagSpecification.${n}.Tag.${i + 1}.Value`] = v;
    });
    return out;
  }
  const tagsOf = (node) => Object.fromEntries(items(node, 'tagSet').map((t) => [textOf(t, 'key'), textOf(t, 'value') ?? '']));
  /** Tags as labels: every tag but Name (which AWS's console shows as the resource's name). */
  const labelsOf = (node) => Object.fromEntries(Object.entries(tagsOf(node)).filter(([k]) => k !== 'Name'));

  async function instancesIn(region, params) {
    const out = [];
    let token = null;
    do {
      const xml = await query('ec2', region, 'DescribeInstances', { ...params, ...(token ? { NextToken: token } : {}) });
      for (const r of items(xml, 'reservationSet')) out.push(...items(r, 'instancesSet'));
      token = textOf(xml, 'nextToken');
    } while (token);
    return out;
  }
  async function instanceNode(ref) {
    const [region, id] = split(ref);
    try {
      const [node] = await instancesIn(region, { 'InstanceId.1': id });
      return node && textOf(node, 'instanceState', 'name') !== 'terminated' ? { region, id, node } : null;
    } catch (err) {
      if (err.code === 'not_found') return null;
      throw err;
    }
  }

  async function permissionsOf(region, groupId) {
    if (!groupId) return [];
    const xml = await query('ec2', region, 'DescribeSecurityGroups', { 'GroupId.1': groupId });
    const group = items(xml, 'securityGroupInfo')[0];
    return items(group, 'ipPermissions').flatMap((p) => {
      const port = Number(textOf(p, 'fromPort'));
      return items(p, 'ipRanges').map((r) => ({ port, from: textOf(r, 'cidrIp') }));
    }).sort((a, b) => a.port - b.port || a.from.localeCompare(b.from));
  }

  async function shape(region, node) {
    const group = textOf(items(node, 'groupSet')[0], 'groupId');
    const state = textOf(node, 'instanceState', 'name');
    return {
      id: `${region}/${textOf(node, 'instanceId')}`, kind: 'vm', name: tagsOf(node).Name ?? textOf(node, 'instanceId'),
      zone: textOf(node, 'placement', 'availabilityZone'), region, machineType: textOf(node, 'instanceType'), status: STATUS[state] ?? state,
      publicIp: textOf(node, 'ipAddress') || null, privateIp: textOf(node, 'privateIpAddress') || null, dnsName: textOf(node, 'dnsName') || null,
      firewall: await permissionsOf(region, group), labels: labelsOf(node), securityGroup: group, createdAt: textOf(node, 'launchTime'),
    };
  }

  /** IpPermissions.N params for [{ port, from }]. */
  function permissionParams(rules) {
    const byPort = new Map();
    for (const r of rules) byPort.set(r.port, [...(byPort.get(r.port) ?? []), r.from]);
    const out = {};
    [...byPort].forEach(([port, froms], i) => {
      const p = `IpPermissions.${i + 1}`;
      Object.assign(out, { [`${p}.IpProtocol`]: 'tcp', [`${p}.FromPort`]: port, [`${p}.ToPort`]: port });
      froms.forEach((from, j) => { out[`${p}.IpRanges.${j + 1}.CidrIp`] = from; });
    });
    return out;
  }

  async function amiFor(region, imageId) {
    const image = catalog.images.find((i) => i.id === imageId) ?? catalog.images[0];
    if (!image.source?.startsWith('/')) throw new CloudError('invalid', `${image.label} is not offered on AWS here yet. Pick another image.`);
    const data = await json('ssm', region, 'AmazonSSM.GetParameter', { Name: image.source });
    const ami = data.Parameter?.Value;
    const xml = await query('ec2', region, 'DescribeImages', { 'ImageId.1': ami });
    return { ami, rootDevice: textOf(items(xml, 'imagesSet')[0], 'rootDeviceName') ?? '/dev/sda1' };
  }

  async function groupFor(region, vpcId, name, labels) {
    const groupName = `noobly-${name}`;
    try {
      const xml = await query('ec2', region, 'CreateSecurityGroup', { GroupName: groupName, GroupDescription: `Noobly Cloud: ${name}`, VpcId: vpcId, ...tagSpec(1, 'security-group', { ...labels, Name: groupName }) });
      return textOf(xml, 'groupId');
    } catch (err) {
      if (err.code !== 'conflict') throw err;
      const xml = await query('ec2', region, 'DescribeSecurityGroups', filters({}, { 'group-name': groupName, 'vpc-id': vpcId }));
      return textOf(items(xml, 'securityGroupInfo')[0], 'groupId');
    }
  }

  const accountApi = {
    async verify() {
      try {
        const xml = await query('sts', STS_REGION, 'GetCallerIdentity', {}, { version: '2011-06-15' });
        const who = textOf(xml, 'GetCallerIdentityResult', 'Account');
        if (account.accountId && who !== account.accountId) return { ok: false, message: `These credentials are for AWS account ${who}, not ${account.accountId}.` };
        accountId = who;
        return { ok: true, identity: textOf(xml, 'GetCallerIdentityResult', 'Arn') };
      } catch (err) {
        if (err instanceof CloudError && ['permission', 'invalid'].includes(err.code)) return { ok: false, message: err.message };
        throw err;
      }
    },
    /** The catalogue's regions this account has enabled. */
    async regions() {
      const xml = await query('ec2', catalog.regions[0].id, 'DescribeRegions', {});
      const enabled = new Set(items(xml, 'regionInfo').map((r) => textOf(r, 'regionName')));
      return catalog.regions.filter((r) => enabled.has(r.id)).map((r) => ({ id: r.id, label: r.label, zones: [...r.zones] }));
    },
    async zones(region) {
      regionInfo(region);
      const xml = await query('ec2', region, 'DescribeAvailabilityZones', filters({}, { state: 'available' }));
      return items(xml, 'availabilityZoneInfo').map((z) => textOf(z, 'zoneName')).sort();
    },
    async detectNetwork(region, { labels = {} } = {}) {
      const xml = await query('ec2', region, 'DescribeVpcs', filters(labels));
      const id = textOf(items(xml, 'vpcSet')[0], 'vpcId');
      return id ? `${region}/${id}` : null;
    },
    /** The region's VPC with DNS hostnames, an internet gateway, a default route and a subnet per zone. */
    async ensureNetwork(region, { labels = {} } = {}) {
      regionInfo(region);
      let created = false;
      let vpcId = (await accountApi.detectNetwork(region, { labels }))?.split('/')[1] ?? null;
      if (!vpcId) {
        const xml = await query('ec2', region, 'CreateVpc', { CidrBlock: `10.${octet(region)}.0.0/16`, ...tagSpec(1, 'vpc', { ...labels, Name: 'noobly-cloud' }) });
        vpcId = textOf(xml, 'vpc', 'vpcId');
        created = true;
      }
      await query('ec2', region, 'ModifyVpcAttribute', { VpcId: vpcId, 'EnableDnsHostnames.Value': 'true' });
      let igw = textOf(items(await query('ec2', region, 'DescribeInternetGateways', filters({}, { 'attachment.vpc-id': vpcId })), 'internetGatewaySet')[0], 'internetGatewayId');
      if (!igw) {
        igw = textOf(await query('ec2', region, 'CreateInternetGateway', tagSpec(1, 'internet-gateway', { ...labels, Name: 'noobly-cloud' })), 'internetGateway', 'internetGatewayId');
        await query('ec2', region, 'AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpcId });
      }
      const table = items(await query('ec2', region, 'DescribeRouteTables', filters({}, { 'vpc-id': vpcId, 'association.main': 'true' })), 'routeTableSet')[0];
      if (!items(table, 'routeSet').some((r) => textOf(r, 'destinationCidrBlock') === '0.0.0.0/0')) {
        await query('ec2', region, 'CreateRoute', { RouteTableId: textOf(table, 'routeTableId'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw });
      }
      const have = new Set(items(await query('ec2', region, 'DescribeSubnets', filters({}, { 'vpc-id': vpcId })), 'subnetSet').map((s) => textOf(s, 'availabilityZone')));
      const zones = await accountApi.zones(region);
      for (const [i, zone] of zones.entries()) {
        if (have.has(zone)) continue;
        await query('ec2', region, 'CreateSubnet', { VpcId: vpcId, AvailabilityZone: zone, CidrBlock: `10.${octet(region)}.${i * 16}.0/20`, ...tagSpec(1, 'subnet', { ...labels, Name: `noobly-cloud-${zone}` }) });
      }
      return { ref: `${region}/${vpcId}`, operation: null, created };
    },
  };

  const compute = {
    /** spec: { name, zone, machineType, image, diskGb, labels, userData, address?, network? } */
    async create(spec) {
      const where = regionOfZone(spec.zone);
      if (!where) throw new CloudError('invalid', `${catalog.short} has no zone ${spec.zone} here.`);
      if (!catalog.machineTypes[spec.machineType]) throw new CloudError('invalid', `${catalog.short} has no instance type ${spec.machineType} here.`);
      const region = where.id;
      const taken = await instancesIn(region, filters({}, { 'tag:Name': spec.name, 'instance-state-name': LIVE_STATES }));
      if (taken.length) throw new CloudError('conflict', `There is already a VM called ${spec.name} in this account.`);
      const vpcId = spec.network ? split(spec.network)[1] : (await accountApi.detectNetwork(region, { labels: { 'noobly-install': spec.labels?.['noobly-install'] } }))?.split('/')[1];
      if (!vpcId) throw new CloudError('invalid', `There is no Noobly Cloud network in ${region}. Check the account again to make it.`);
      const subnet = textOf(items(await query('ec2', region, 'DescribeSubnets', filters({}, { 'vpc-id': vpcId, 'availability-zone': spec.zone })), 'subnetSet')[0], 'subnetId');
      if (!subnet) throw new CloudError('invalid', `The network has no subnet in ${spec.zone}. Check the account again to add it.`);
      const { ami, rootDevice } = await amiFor(region, spec.image);
      const labels = spec.labels ?? {};
      const group = await groupFor(region, vpcId, spec.name, labels);
      const xml = await query('ec2', region, 'RunInstances', {
        ImageId: ami, InstanceType: spec.machineType, MinCount: 1, MaxCount: 1, SubnetId: subnet, 'SecurityGroupId.1': group,
        ...(spec.userData ? { UserData: Buffer.from(spec.userData).toString('base64') } : {}),
        'BlockDeviceMapping.1.DeviceName': rootDevice, 'BlockDeviceMapping.1.Ebs.VolumeSize': spec.diskGb ?? catalog.disk.minGb,
        'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3', 'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
        'MetadataOptions.HttpTokens': 'required',
        ...tagSpec(1, 'instance', { ...labels, Name: spec.name }), ...tagSpec(2, 'volume', { ...labels, Name: spec.name }),
      });
      const instance = textOf(items(xml, 'instancesSet')[0], 'instanceId');
      return { ref: `${region}/${instance}`, operation: { kind: 'aws', region, instance, until: 'running', allocation: spec.address ? split(spec.address)[1] : null } };
    },
    async get(ref) {
      const found = await instanceNode(ref);
      return found ? shape(found.region, found.node) : null;
    },
    async list({ labels = {} } = {}) {
      const out = [];
      for (const r of catalog.regions) {
        try {
          for (const node of await instancesIn(r.id, filters(labels, { 'instance-state-name': LIVE_STATES }))) out.push(await shape(r.id, node));
        } catch (err) {
          if (err.code !== 'permission') throw err; // a region not enabled for the account
        }
      }
      return out.filter((v) => hasLabels(v, labels));
    },
    async start(ref) {
      const [region, id] = split(ref);
      await query('ec2', region, 'StartInstances', { 'InstanceId.1': id });
      return { ref, operation: { kind: 'aws', region, instance: id, until: 'running' } };
    },
    async stop(ref) {
      const [region, id] = split(ref);
      await query('ec2', region, 'StopInstances', { 'InstanceId.1': id });
      return { ref, operation: { kind: 'aws', region, instance: id, until: 'stopped' } };
    },
    /** A reboot keeps the instance running: nothing to wait for. */
    async restart(ref) {
      const [region, id] = split(ref);
      await query('ec2', region, 'RebootInstances', { 'InstanceId.1': id });
      return { ref, operation: null };
    },
    /** Terminates the instance; its security group goes once it has. */
    async remove(ref) {
      const found = await instanceNode(ref);
      if (!found) return { ref, operation: null };
      await query('ec2', found.region, 'TerminateInstances', { 'InstanceId.1': found.id });
      return { ref, operation: { kind: 'aws', region: found.region, instance: found.id, until: 'terminated', group: textOf(items(found.node, 'groupSet')[0], 'groupId') } };
    },
    async reserveAddress(region, { labels = {} } = {}) {
      regionInfo(region);
      const xml = await query('ec2', region, 'AllocateAddress', { Domain: 'vpc', ...tagSpec(1, 'elastic-ip', { ...labels, Name: `noobly-${labels['noobly-name'] ?? 'vm'}` }) });
      return { ref: `${region}/${textOf(xml, 'allocationId')}`, address: textOf(xml, 'publicIp'), operation: null };
    },
    async releaseAddress(ref) {
      const [region, id] = split(ref);
      try {
        const a = items(await query('ec2', region, 'DescribeAddresses', { 'AllocationId.1': id }), 'addressesSet')[0];
        const association = textOf(a, 'associationId');
        if (association) await query('ec2', region, 'DisassociateAddress', { AssociationId: association });
        await query('ec2', region, 'ReleaseAddress', { AllocationId: id });
      } catch (err) {
        if (err.code !== 'not_found') throw err;
      }
      return { ref, operation: null };
    },
    /** rules: [{ port, from }]: the VM's security group is made to allow exactly these. */
    async setFirewall(ref, rules = []) {
      const found = await instanceNode(ref);
      if (!found) throw new CloudError('not_found', `There is no VM ${ref} in this account.`);
      const group = textOf(items(found.node, 'groupSet')[0], 'groupId');
      const have = await permissionsOf(found.region, group);
      const want = rules.map((r) => ({ port: Number(r.port), from: r.from }));
      const key = (r) => `${r.port} ${r.from}`;
      const revoke = have.filter((r) => !want.some((w) => key(w) === key(r)));
      const add = want.filter((w) => !have.some((r) => key(r) === key(w)));
      if (revoke.length) await query('ec2', found.region, 'RevokeSecurityGroupIngress', { GroupId: group, ...permissionParams(revoke) });
      if (add.length) await query('ec2', found.region, 'AuthorizeSecurityGroupIngress', { GroupId: group, ...permissionParams(add) });
      return { ref, operation: null };
    },
    /** The public DNS name AWS gives the VM (it follows its Elastic IP). */
    async defaultAddress(ref) {
      const found = await instanceNode(ref);
      return found ? textOf(found.node, 'dnsName') || null : null;
    },
  };

  async function waitFor(h, { signal, onProgress } = {}) {
    if (!h) return;
    for (let n = 1; ; n += 1) {
      let state;
      try {
        const [node] = await instancesIn(h.region, { 'InstanceId.1': h.instance });
        state = node ? textOf(node, 'instanceState', 'name') : 'terminated';
      } catch (err) {
        if (err.code !== 'not_found') throw err;
        state = h.until === 'terminated' ? 'terminated' : 'pending'; // just launched: EC2 is eventually consistent
      }
      if (state === h.until) break;
      if (h.until === 'running' && ['terminated', 'shutting-down'].includes(state)) throw new CloudError('invalid', `AWS stopped the new instance (${state}). Its console output says why.`);
      onProgress?.(Math.min(0.9, n * 0.1));
      await sleep(pollMs, signal);
    }
    if (h.allocation) {
      const a = items(await query('ec2', h.region, 'DescribeAddresses', { 'AllocationId.1': h.allocation }), 'addressesSet')[0];
      if (textOf(a, 'instanceId') !== h.instance) await query('ec2', h.region, 'AssociateAddress', { AllocationId: h.allocation, InstanceId: h.instance });
    }
    if (h.group) {
      try {
        await query('ec2', h.region, 'DeleteSecurityGroup', { GroupId: h.group });
      } catch (err) {
        if (!['not_found', 'conflict'].includes(err.code)) throw err;
      }
    }
  }

  // ------------------------------------------------------------------ ECR

  /**
   * An ECR path or image ref: <account>.dkr.ecr.<region>.amazonaws.com/<repository>[:<tag>]. ECR keeps one repository
   * per image, so the builds' <path>/<tenant>/<workload> is the repository <name>/<tenant>/<workload>.
   */
  const parseRef = (ref) => {
    const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*?)(?::([\w][\w.-]{0,127}))?$/.exec(ref);
    if (!m) throw new CloudError('invalid', `${ref} is not an ECR path.`);
    return { region: m[2], repo: m[3], tag: m[4] ?? null };
  };
  const ownAccount = async () => {
    if (!accountId) await accountApi.verify();
    return accountId;
  };
  async function token(region, creds) {
    const data = await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken', {}, { creds });
    const auth = data.authorizationData?.[0];
    const [, password] = Buffer.from(auth.authorizationToken, 'base64').toString('utf8').split(':');
    return { server: `${await ownAccount()}.dkr.ecr.${region}.amazonaws.com`, username: 'AWS', password, expiresAt: new Date(Number(auth.expiresAt) * 1000).toISOString() };
  }

  const registry = {
    async ensure(region, { name, labels = {} } = {}) {
      regionInfo(region);
      if (!/^[a-z][a-z0-9-]{1,62}$/.test(name ?? '')) throw new CloudError('invalid', 'A repository name is lower-case letters, digits and hyphens.');
      try {
        await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.CreateRepository', { repositoryName: name, imageTagMutability: 'MUTABLE', tags: Object.entries(labels).map(([Key, Value]) => ({ Key, Value })) });
      } catch (err) {
        if (err.code !== 'conflict') throw err;
      }
      const host = `${await ownAccount()}.dkr.ecr.${region}.amazonaws.com`;
      return { host, path: `${host}/${name}` };
    },
    pushCredentials: async (region) => token(regionInfo(region).id),
    /** From the reader role: its token may only pull. */
    async pullCredentials(region) {
      regionInfo(region);
      const role = given.pullRoleArn ?? `arn:aws:iam::${await ownAccount()}:role/noobly-pull`;
      return token(region, await assume(role, null, await current()));
    },
    /** Makes the repository an image ref needs before it is pushed (ECR has one per image; not on every provider). */
    async prepare(ref) {
      const { region, repo } = parseRef(ref);
      try {
        await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.CreateRepository', { repositoryName: repo, imageTagMutability: 'MUTABLE', tags: [{ Key: 'managed-by', Value: 'noobly-cloud' }] });
      } catch (err) {
        if (err.code !== 'conflict') throw err;
      }
    },
    /** Every tagged image in the repositories under the path. */
    async list(path) {
      const { region, repo: prefix } = parseRef(path);
      const host = path.slice(0, path.indexOf('/'));
      const repos = [];
      let nextToken;
      do {
        const data = await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.DescribeRepositories', nextToken ? { nextToken } : {});
        repos.push(...(data.repositories ?? []).map((r) => r.repositoryName).filter((n) => n === prefix || n.startsWith(`${prefix}/`)));
        nextToken = data.nextToken;
      } while (nextToken);
      const out = [];
      for (const repositoryName of repos) {
        nextToken = undefined;
        do {
          const data = await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.DescribeImages', { repositoryName, ...(nextToken ? { nextToken } : {}) });
          for (const img of data.imageDetails ?? []) {
            for (const tag of img.imageTags ?? []) out.push({ ref: `${host}/${repositoryName}:${tag}`, tag, digest: img.imageDigest, pushedAt: new Date(Number(img.imagePushedAt) * 1000).toISOString(), labels: {} });
          }
          nextToken = data.nextToken;
        } while (nextToken);
      }
      return out.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
    },
    async remove(ref) {
      const { region, repo, tag } = parseRef(ref);
      if (!tag) throw new CloudError('invalid', `${ref} has no tag.`);
      const data = await json('ecr', region, 'AmazonEC2ContainerRegistry_V20150921.BatchDeleteImage', { repositoryName: repo, imageIds: [{ imageTag: tag }] });
      return { ref, removed: (data.imageIds ?? []).length > 0 };
    },
  };

  return {
    name: 'aws',
    cloud: 'aws',
    account: accountApi,
    registry,
    catalog: {
      async machineTypes(zone) {
        const where = regionOfZone(zone);
        if (!where) throw new CloudError('invalid', `${catalog.short} has no zone ${zone} here.`);
        const xml = await query('ec2', where.id, 'DescribeInstanceTypeOfferings', { LocationType: 'availability-zone', ...filters({}, { location: zone }) });
        const offered = new Set(items(xml, 'instanceTypeOfferingSet').map((o) => textOf(o, 'instanceType')));
        return Object.entries(catalog.machineTypes).filter(([id]) => offered.has(id)).map(([id, m]) => ({ id, vcpu: m.vcpu, memoryGb: m.memoryGb }));
      },
      async images() {
        return catalog.images.filter((i) => i.source?.startsWith('/')).map((i) => ({ id: i.id, label: i.label }));
      },
    },
    compute,
    metrics: {
      /** Mean CPU over the window, from CloudWatch. */
      async vm(ref, window = '1h') {
        const found = await instanceNode(ref);
        if (!found) throw new CloudError('not_found', `There is no VM ${ref} in this account.`);
        if (textOf(found.node, 'instanceState', 'name') !== 'running') return { window, cpuPercent: null };
        const seconds = { '1h': 3600, '24h': 86400 }[window] ?? 3600;
        const xml = await query('monitoring', found.region, 'GetMetricStatistics', {
          Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', 'Dimensions.member.1.Name': 'InstanceId', 'Dimensions.member.1.Value': found.id,
          StartTime: new Date(now() - seconds * 1000).toISOString(), EndTime: new Date(now()).toISOString(), Period: seconds, 'Statistics.member.1': 'Average',
        }, { version: '2010-08-01' });
        const points = children(at(xml, 'GetMetricStatisticsResult', 'Datapoints'), 'member').map((m) => Number(textOf(m, 'Average')));
        return { window, cpuPercent: points.length ? Math.round(points.reduce((a, b) => a + b, 0) / points.length) : null };
      },
    },
    async inventory({ labels = {} } = {}) {
      const vms = await compute.list({ labels });
      const addresses = [];
      const networks = [];
      for (const r of catalog.regions) {
        try {
          for (const a of items(await query('ec2', r.id, 'DescribeAddresses', filters(labels)), 'addressesSet')) {
            addresses.push({ id: `${r.id}/${textOf(a, 'allocationId')}`, kind: 'address', region: r.id, address: textOf(a, 'publicIp'), status: textOf(a, 'associationId') ? 'in-use' : 'reserved', labels: labelsOf(a) });
          }
          for (const v of items(await query('ec2', r.id, 'DescribeVpcs', filters(labels)), 'vpcSet')) {
            networks.push({ id: `${r.id}/${textOf(v, 'vpcId')}`, kind: 'network', region: r.id, name: 'noobly-cloud', status: textOf(v, 'state') === 'available' ? 'ready' : 'creating', labels: labelsOf(v) });
          }
        } catch (err) {
          if (err.code !== 'permission') throw err;
        }
      }
      return { vms, addresses, networks, databases: [], buckets: [] };
    },
    waitFor,
  };
}
