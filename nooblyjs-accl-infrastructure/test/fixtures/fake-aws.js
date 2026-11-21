// A fake of the AWS APIs the AWS adapter calls (roadmap 2.9, 2.10), on a local port. Every request must carry a SigV4
// signature that it recomputes with the secret it knows (the signer itself is checked against AWS's published example
// in aws.test.js). The adapter's endpoint(service, region) is `${url}/<service>/<region>/`. It answers STS
// (GetCallerIdentity, AssumeRole with the external ID), EC2 (regions, zones, VPCs, internet gateways, route tables,
// subnets, security groups, instances, Elastic IPs, instance type offerings, images), SSM (GetParameter), CloudWatch
// (GetMetricStatistics) and ECR. Instances move one state per look. failNext() makes the next matching action fail.
import http from 'node:http';
import { signRequest } from '../../src/providers/http/sigv4.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A JS value as AWS Query XML: arrays become <item>s (or <member>s for CloudWatch). */
function xml(value, member = 'item') {
  if (Array.isArray(value)) return value.map((v) => `<${member}>${xml(v, member)}</${member}>`).join('');
  if (value && typeof value === 'object') return Object.entries(value).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `<${k}>${xml(v, member)}</${k}>`).join('');
  return esc(value);
}
const tagSet = (tags) => Object.entries(tags ?? {}).map(([key, value]) => ({ key, value }));

export async function createFakeAws({ accountId = '111122223333', regions }) {
  const keys = new Map([['AKIAFAKEBASE00000001', { secret: 'base-secret', kind: 'base' }], ['AKIAFAKEDIRECT000001', { secret: 'direct-secret', kind: 'direct' }]]);
  const state = { vpcs: [], igws: [], tables: [], subnets: [], groups: [], instances: [], addresses: [], repos: new Map(), images: [], calls: [], assumed: [] };
  const failures = [];
  let n = 0;
  let url = '';
  const id = (prefix) => `${prefix}-${(n += 1).toString(16).padStart(17, '0')}`;
  const zonesOf = (region) => regions.find((r) => r.id === region)?.zones ?? [];

  /** Recomputes the signature: → the credentials' record, or null. */
  function checkSignature(req, body, service, region) {
    const auth = String(req.headers.authorization ?? '');
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m || m[3] !== region || m[4] !== service) return null;
    const who = keys.get(m[1]);
    if (!who) return null;
    const stamp = req.headers['x-amz-date'];
    const signed = m[5].split(';');
    const headers = Object.fromEntries(signed.filter((h) => !['host', 'x-amz-date', 'x-amz-security-token'].includes(h)).map((h) => [h, req.headers[h]]));
    const credentials = { accessKeyId: m[1], secretAccessKey: who.secret, sessionToken: req.headers['x-amz-security-token'] };
    if (who.token && who.token !== credentials.sessionToken) return null;
    const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    const again = signRequest({ method: req.method, url: `${url}${req.url}`, headers, body, service, region, credentials, date });
    return again.authorization === auth ? { ...who, accessKeyId: m[1] } : null;
  }

  const sendXml = (res, status, action, result, member) => {
    res.writeHead(status, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="https://fake/"><requestId>r-${n}</requestId>${xml(result, member)}</${action}Response>`);
  };
  const xmlError = (res, status, code, message) => {
    res.writeHead(status, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message></Error></Errors><RequestID>r</RequestID></Response>`);
  };
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify(body));
  };
  const jsonError = (res, status, type, message) => sendJson(res, status, { __type: `com.amazonaws#${type}`, message });

  /** Filter.N.Name / Filter.N.Value.M → [[name, [values]]] */
  function filtersOf(form) {
    const out = [];
    for (let i = 1; form.has(`Filter.${i}.Name`); i += 1) {
      const values = [];
      for (let j = 1; form.has(`Filter.${i}.Value.${j}`); j += 1) values.push(form.get(`Filter.${i}.Value.${j}`));
      out.push([form.get(`Filter.${i}.Name`), values]);
    }
    return out;
  }
  /** Does a resource match the filters? `fields` maps a filter name to the resource's value(s). */
  const matches = (form, tags, fields = {}) => filtersOf(form).every(([name, values]) => {
    if (name.startsWith('tag:')) return values.includes(tags?.[name.slice(4)]);
    const have = [].concat(fields[name] ?? []);
    return have.some((v) => values.includes(String(v)));
  });
  function tagsFrom(form, type) {
    for (let i = 1; form.has(`TagSpecification.${i}.ResourceType`); i += 1) {
      if (form.get(`TagSpecification.${i}.ResourceType`) !== type) continue;
      const tags = {};
      for (let j = 1; form.has(`TagSpecification.${i}.Tag.${j}.Key`); j += 1) tags[form.get(`TagSpecification.${i}.Tag.${j}.Key`)] = form.get(`TagSpecification.${i}.Tag.${j}.Value`);
      return tags;
    }
    return {};
  }
  function permissionsFrom(form) {
    const out = [];
    for (let i = 1; form.has(`IpPermissions.${i}.FromPort`); i += 1) {
      for (let j = 1; form.has(`IpPermissions.${i}.IpRanges.${j}.CidrIp`); j += 1) out.push({ port: Number(form.get(`IpPermissions.${i}.FromPort`)), from: form.get(`IpPermissions.${i}.IpRanges.${j}.CidrIp`) });
    }
    return out;
  }
  /** One step on per look: pending → running, stopping → stopped, shutting-down → terminated. */
  function advance(vm) {
    const next = { pending: 'running', stopping: 'stopped', 'shutting-down': 'terminated' }[vm.state];
    if (next && (vm.looks += 1) >= 2) {
      vm.state = next;
      vm.looks = 0;
      if (next === 'running' && !vm.ip) vm.ip = `13.244.0.${state.instances.indexOf(vm) + 10}`;
    }
  }
  const instanceXml = (vm) => {
    const eip = state.addresses.find((a) => a.instance === vm.id);
    const ip = vm.state === 'running' ? eip?.ip ?? vm.ip : null;
    return {
      instanceId: vm.id, imageId: vm.ami, instanceState: { code: 16, name: vm.state }, instanceType: vm.type, placement: { availabilityZone: vm.zone },
      privateIpAddress: vm.privateIp, ipAddress: ip, dnsName: ip ? `ec2-${ip.replaceAll('.', '-')}.${vm.region}.compute.amazonaws.com` : '',
      groupSet: [{ groupId: vm.group, groupName: `g` }], tagSet: tagSet(vm.tags), launchTime: vm.launchTime,
    };
  };

  function ec2(res, action, form, region) {
    const send = (result) => sendXml(res, 200, action, result);
    switch (action) {
      case 'DescribeRegions': return send({ regionInfo: regions.map((r) => ({ regionName: r.id, endpoint: `ec2.${r.id}.amazonaws.com` })) });
      case 'DescribeAvailabilityZones': return send({ availabilityZoneInfo: zonesOf(region).map((z) => ({ zoneName: z, zoneState: 'available', regionName: region })) });
      case 'DescribeVpcs': return send({ vpcSet: state.vpcs.filter((v) => v.region === region && matches(form, v.tags, { 'vpc-id': v.id })).map((v) => ({ vpcId: v.id, state: 'available', cidrBlock: v.cidr, tagSet: tagSet(v.tags) })) });
      case 'CreateVpc': {
        const v = { id: id('vpc'), region, cidr: form.get('CidrBlock'), tags: tagsFrom(form, 'vpc'), dnsHostnames: false };
        state.vpcs.push(v);
        state.tables.push({ id: id('rtb'), region, vpc: v.id, main: true, routes: [{ destinationCidrBlock: v.cidr, gatewayId: 'local' }] });
        return send({ vpc: { vpcId: v.id, state: 'pending', cidrBlock: v.cidr } });
      }
      case 'ModifyVpcAttribute': {
        const v = state.vpcs.find((x) => x.id === form.get('VpcId'));
        if (!v) return xmlError(res, 400, 'InvalidVpcID.NotFound', `The vpc ID '${form.get('VpcId')}' does not exist`);
        v.dnsHostnames = form.get('EnableDnsHostnames.Value') === 'true';
        return send({ return: true });
      }
      case 'DescribeInternetGateways': return send({ internetGatewaySet: state.igws.filter((g) => g.region === region && matches(form, g.tags, { 'attachment.vpc-id': g.vpc ?? [] })).map((g) => ({ internetGatewayId: g.id, attachmentSet: g.vpc ? [{ vpcId: g.vpc, state: 'available' }] : [] })) });
      case 'CreateInternetGateway': {
        const g = { id: id('igw'), region, vpc: null, tags: tagsFrom(form, 'internet-gateway') };
        state.igws.push(g);
        return send({ internetGateway: { internetGatewayId: g.id } });
      }
      case 'AttachInternetGateway': {
        state.igws.find((g) => g.id === form.get('InternetGatewayId')).vpc = form.get('VpcId');
        return send({ return: true });
      }
      case 'DescribeRouteTables': return send({ routeTableSet: state.tables.filter((t) => t.region === region && matches(form, {}, { 'vpc-id': t.vpc, 'association.main': String(t.main) })).map((t) => ({ routeTableId: t.id, vpcId: t.vpc, routeSet: t.routes })) });
      case 'CreateRoute': {
        state.tables.find((t) => t.id === form.get('RouteTableId')).routes.push({ destinationCidrBlock: form.get('DestinationCidrBlock'), gatewayId: form.get('GatewayId') });
        return send({ return: true });
      }
      case 'DescribeSubnets': return send({ subnetSet: state.subnets.filter((s) => s.region === region && matches(form, s.tags, { 'vpc-id': s.vpc, 'availability-zone': s.zone })).map((s) => ({ subnetId: s.id, vpcId: s.vpc, availabilityZone: s.zone, cidrBlock: s.cidr })) });
      case 'CreateSubnet': {
        const s = { id: id('subnet'), region, vpc: form.get('VpcId'), zone: form.get('AvailabilityZone'), cidr: form.get('CidrBlock'), tags: tagsFrom(form, 'subnet') };
        state.subnets.push(s);
        return send({ subnet: { subnetId: s.id } });
      }
      case 'CreateSecurityGroup': {
        if (state.groups.some((g) => g.vpc === form.get('VpcId') && g.name === form.get('GroupName'))) return xmlError(res, 400, 'InvalidGroup.Duplicate', `The security group '${form.get('GroupName')}' already exists for VPC '${form.get('VpcId')}'`);
        const g = { id: id('sg'), region, vpc: form.get('VpcId'), name: form.get('GroupName'), rules: [], tags: tagsFrom(form, 'security-group') };
        state.groups.push(g);
        return send({ return: true, groupId: g.id });
      }
      case 'DescribeSecurityGroups': {
        const want = form.get('GroupId.1');
        const found = state.groups.filter((g) => g.region === region && (!want || g.id === want) && matches(form, g.tags, { 'group-name': g.name, 'vpc-id': g.vpc }));
        if (want && !found.length) return xmlError(res, 400, 'InvalidGroup.NotFound', `The security group '${want}' does not exist`);
        const byPort = (rules) => [...new Set(rules.map((r) => r.port))].map((port) => ({ ipProtocol: 'tcp', fromPort: port, toPort: port, ipRanges: rules.filter((r) => r.port === port).map((r) => ({ cidrIp: r.from })) }));
        return send({ securityGroupInfo: found.map((g) => ({ groupId: g.id, groupName: g.name, vpcId: g.vpc, ipPermissions: byPort(g.rules) })) });
      }
      case 'AuthorizeSecurityGroupIngress':
      case 'RevokeSecurityGroupIngress': {
        const g = state.groups.find((x) => x.id === form.get('GroupId'));
        const rules = permissionsFrom(form);
        const key = (r) => `${r.port} ${r.from}`;
        if (action.startsWith('Authorize')) {
          if (rules.some((r) => g.rules.some((x) => key(x) === key(r)))) return xmlError(res, 400, 'InvalidPermission.Duplicate', 'the specified rule already exists');
          g.rules.push(...rules);
        } else g.rules = g.rules.filter((x) => !rules.some((r) => key(r) === key(x)));
        return send({ return: true });
      }
      case 'DeleteSecurityGroup': {
        const g = form.get('GroupId');
        if (state.instances.some((v) => v.group === g && v.state !== 'terminated')) return xmlError(res, 400, 'DependencyViolation', `resource ${g} has a dependent object`);
        state.groups = state.groups.filter((x) => x.id !== g);
        return send({ return: true });
      }
      case 'DescribeImages': return send({ imagesSet: [{ imageId: form.get('ImageId.1'), rootDeviceName: '/dev/sda1', state: 'available' }] });
      case 'DescribeInstanceTypeOfferings': return send({ instanceTypeOfferingSet: ['t3.small', 't3.medium', 't3.large', 't3.xlarge', 't3.2xlarge'].map((t) => ({ instanceType: t, locationType: 'availability-zone', location: filtersOf(form)[0]?.[1]?.[0] })) });
      case 'RunInstances': {
        const type = form.get('InstanceType');
        if (!/^t3\./.test(type)) return xmlError(res, 400, 'InvalidParameterValue', `Invalid value '${type}' for InstanceType.`);
        const subnet = state.subnets.find((s) => s.id === form.get('SubnetId'));
        if (!subnet) return xmlError(res, 400, 'InvalidSubnetID.NotFound', `The subnet ID '${form.get('SubnetId')}' does not exist`);
        const vm = {
          id: id('i'), region, zone: subnet.zone, type, ami: form.get('ImageId'), state: 'pending', looks: 0, group: form.get('SecurityGroupId.1'), tags: tagsFrom(form, 'instance'),
          userData: Buffer.from(form.get('UserData') ?? '', 'base64').toString(), diskGb: Number(form.get('BlockDeviceMapping.1.Ebs.VolumeSize')), imdsv2: form.get('MetadataOptions.HttpTokens'),
          privateIp: `10.128.0.${state.instances.length + 4}`, ip: null, launchTime: new Date().toISOString(),
        };
        state.instances.push(vm);
        return send({ reservationId: id('r'), instancesSet: [instanceXml(vm)] });
      }
      case 'DescribeInstances': {
        const want = form.get('InstanceId.1');
        const found = state.instances.filter((v) => v.region === region && (!want || v.id === want));
        if (want && !found.length) return xmlError(res, 400, 'InvalidInstanceID.NotFound', `The instance ID '${want}' does not exist`);
        found.forEach(advance);
        const listed = found.filter((v) => matches(form, v.tags, { 'instance-state-name': v.state }));
        return send({ reservationSet: listed.length ? [{ reservationId: 'r-1', instancesSet: listed.map(instanceXml) }] : [] });
      }
      case 'StartInstances':
      case 'StopInstances':
      case 'RebootInstances':
      case 'TerminateInstances': {
        const vm = state.instances.find((v) => v.id === form.get('InstanceId.1'));
        if (!vm) return xmlError(res, 400, 'InvalidInstanceID.NotFound', 'no such instance');
        const [from, to] = { StartInstances: [['stopped'], 'pending'], StopInstances: [['running'], 'stopping'], RebootInstances: [['running'], 'running'], TerminateInstances: [['pending', 'running', 'stopping', 'stopped'], 'shutting-down'] }[action];
        if (!from.includes(vm.state)) return xmlError(res, 400, 'IncorrectInstanceState', `The instance '${vm.id}' is not in a state from which it can be ${action.replace('Instances', '').toLowerCase()}ed.`);
        vm.state = to;
        vm.looks = 0;
        if (to === 'shutting-down') for (const a of state.addresses) if (a.instance === vm.id) Object.assign(a, { instance: null, association: null });
        return send({ return: true });
      }
      case 'AllocateAddress': {
        const a = { id: id('eipalloc'), region, ip: `13.245.1.${state.addresses.length + 10}`, instance: null, association: null, tags: tagsFrom(form, 'elastic-ip') };
        state.addresses.push(a);
        return send({ publicIp: a.ip, allocationId: a.id, domain: 'vpc' });
      }
      case 'DescribeAddresses': {
        const want = form.get('AllocationId.1');
        const found = state.addresses.filter((a) => a.region === region && (!want || a.id === want) && matches(form, a.tags));
        if (want && !found.length) return xmlError(res, 400, 'InvalidAllocationID.NotFound', `The allocation ID '${want}' does not exist`);
        return send({ addressesSet: found.map((a) => ({ allocationId: a.id, publicIp: a.ip, instanceId: a.instance, associationId: a.association, domain: 'vpc', tagSet: tagSet(a.tags) })) });
      }
      case 'AssociateAddress': {
        const a = state.addresses.find((x) => x.id === form.get('AllocationId'));
        const vm = state.instances.find((v) => v.id === form.get('InstanceId'));
        if (vm.state !== 'running') return xmlError(res, 400, 'IncorrectInstanceState', 'The instance is not running');
        Object.assign(a, { instance: vm.id, association: id('eipassoc') });
        return send({ return: true, associationId: a.association });
      }
      case 'DisassociateAddress': {
        const a = state.addresses.find((x) => x.association === form.get('AssociationId'));
        Object.assign(a, { instance: null, association: null });
        return send({ return: true });
      }
      case 'ReleaseAddress': {
        const a = state.addresses.find((x) => x.id === form.get('AllocationId'));
        if (!a) return xmlError(res, 400, 'InvalidAllocationID.NotFound', 'no such address');
        if (a.association) return xmlError(res, 400, 'InvalidIPAddress.InUse', 'Address is in use');
        state.addresses = state.addresses.filter((x) => x !== a);
        return send({ return: true });
      }
      default: return xmlError(res, 400, 'InvalidAction', `The action ${action} is not valid for this web service.`);
    }
  }

  function ecr(res, target, body, region) {
    const repoKey = (name) => `${region}/${name}`;
    switch (target) {
      case 'CreateRepository': {
        if (state.repos.has(repoKey(body.repositoryName))) return jsonError(res, 400, 'RepositoryAlreadyExistsException', `The repository with name '${body.repositoryName}' already exists`);
        state.repos.set(repoKey(body.repositoryName), { tags: body.tags });
        return sendJson(res, 200, { repository: { repositoryName: body.repositoryName, repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/${body.repositoryName}` } });
      }
      case 'DescribeRepositories': return sendJson(res, 200, { repositories: [...state.repos.keys()].filter((k) => k.startsWith(`${region}/`)).map((k) => ({ repositoryName: k.slice(region.length + 1) })) });
      case 'DescribeImages': {
        if (!state.repos.has(repoKey(body.repositoryName))) return jsonError(res, 400, 'RepositoryNotFoundException', `The repository with name '${body.repositoryName}' does not exist`);
        return sendJson(res, 200, { imageDetails: state.images.filter((i) => i.region === region && i.repo === body.repositoryName).map((i) => ({ imageDigest: i.digest, imageTags: i.tags, imagePushedAt: i.pushedAt })) });
      }
      case 'BatchDeleteImage': {
        const tags = body.imageIds.map((i) => i.imageTag);
        const gone = state.images.filter((i) => i.region === region && i.repo === body.repositoryName && i.tags.some((t) => tags.includes(t)));
        state.images = state.images.filter((i) => !gone.includes(i));
        return sendJson(res, 200, { imageIds: gone.map((i) => ({ imageDigest: i.digest })), failures: [] });
      }
      default: return jsonError(res, 400, 'UnknownOperationException', target);
    }
  }

  async function route(req, res, body) {
    const [, service, region] = /^\/([a-z0-9]+)\/([a-z0-9-]+)\/$/.exec(req.url) ?? [];
    if (!service || req.method !== 'POST') return xmlError(res, 404, 'NotFound', req.url);
    const who = checkSignature(req, body, service, region);
    const form = new URLSearchParams(body);
    const target = String(req.headers['x-amz-target'] ?? '').split('.').pop();
    const action = target || form.get('Action');
    state.calls.push(`${service} ${region} ${action}${who ? ` as ${who.kind}` : ''}`);
    if (!who) return target ? jsonError(res, 403, 'InvalidSignatureException', 'The request signature we calculated does not match the signature you provided.') : xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
    const fail = failures.findIndex((f) => f.action === action);
    if (fail >= 0) {
      const [f] = failures.splice(fail, 1);
      return target ? jsonError(res, f.status, f.code, f.message) : xmlError(res, f.status, f.code, f.message);
    }
    // The base credentials may only assume roles.
    if (who.kind === 'base' && action !== 'AssumeRole') return xmlError(res, 403, 'AccessDenied', `User: arn:aws:iam::999999999999:user/noobly-server is not authorized to perform: ${service}:${action}`);

    if (service === 'sts') {
      if (action === 'GetCallerIdentity') return sendXml(res, 200, action, { GetCallerIdentityResult: { Arn: who.arn ?? `arn:aws:iam::${accountId}:user/noobly`, UserId: 'AIDAFAKE', Account: accountId } });
      if (action === 'AssumeRole') {
        const role = form.get('RoleArn');
        const isMain = role === `arn:aws:iam::${accountId}:role/noobly-cloud`;
        const isPull = role === `arn:aws:iam::${accountId}:role/noobly-pull`;
        if (!(isMain && who.kind === 'base' && form.get('ExternalId') === 'nc-ext-123') && !(isPull && who.kind !== 'base')) return xmlError(res, 403, 'AccessDenied', `User is not authorized to perform: sts:AssumeRole on resource: ${role}`);
        const key = `ASIAFAKE${String((n += 1)).padStart(12, '0')}`;
        const token = `session-${n}`;
        keys.set(key, { secret: `secret-${n}`, kind: isPull ? 'pull' : 'role', token, arn: `arn:aws:sts::${accountId}:assumed-role/${role.split('/').pop()}/noobly-cloud` });
        state.assumed.push(role);
        return sendXml(res, 200, action, { AssumeRoleResult: { Credentials: { AccessKeyId: key, SecretAccessKey: `secret-${n}`, SessionToken: token, Expiration: new Date(Date.now() + 3600_000).toISOString() } } });
      }
    }
    if (service === 'ec2') return ec2(res, action, form, region);
    if (service === 'ssm' && target === 'GetParameter') {
      const name = JSON.parse(body).Name;
      if (!name.startsWith('/aws/service/')) return jsonError(res, 400, 'ParameterNotFound', `Parameter ${name} not found.`);
      return sendJson(res, 200, { Parameter: { Name: name, Type: 'String', Value: `ami-0${Buffer.from(name).toString('hex').slice(-16)}` } });
    }
    if (service === 'monitoring' && action === 'GetMetricStatistics') {
      return sendXml(res, 200, action, { GetMetricStatisticsResult: { Label: 'CPUUtilization', Datapoints: [{ Average: 21.5, Unit: 'Percent' }, { Average: 24.5, Unit: 'Percent' }] } }, 'member');
    }
    if (service === 'ecr') {
      if (target === 'GetAuthorizationToken') {
        if (who.kind === 'pull') return sendJson(res, 200, { authorizationData: [{ authorizationToken: Buffer.from('AWS:pull-password').toString('base64'), expiresAt: Math.floor(Date.now() / 1000) + 43200 }] });
        return sendJson(res, 200, { authorizationData: [{ authorizationToken: Buffer.from('AWS:push-password').toString('base64'), expiresAt: Math.floor(Date.now() / 1000) + 43200 }] });
      }
      return ecr(res, target, JSON.parse(body || '{}'), region);
    }
    return xmlError(res, 400, 'InvalidAction', `${service} ${action}`);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => route(req, res, body).catch((err) => xmlError(res, 500, 'InternalError', err.message)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    accountId,
    state,
    endpoint: (service, region) => `${url}/${service}/${region}/`,
    /** This server's own credentials: they may only assume the role. */
    base: { accessKeyId: 'AKIAFAKEBASE00000001', secretAccessKey: 'base-secret' },
    /** What a person pastes: the role and its external ID. */
    role: `arn:aws:iam::${accountId}:role/noobly-cloud\nnc-ext-123`,
    /** Or access keys. */
    direct: { accessKeyId: 'AKIAFAKEDIRECT000001', secretAccessKey: 'direct-secret' },
    /** The next call of `action` fails with AWS's error. */
    failNext(action, status, code, message) {
      failures.push({ action, status, code, message });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
