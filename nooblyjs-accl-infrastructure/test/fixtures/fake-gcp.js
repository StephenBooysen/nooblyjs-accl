// A fake of the Google APIs the GCP adapter calls (roadmap 2.8, 2.10), on a local port: the OAuth token endpoint (it
// checks the JWT's RS256 signature with the key's public half), Compute Engine (networks, subnetworks, addresses,
// instances, firewalls, machine types, zone/region/global operations), Cloud Monitoring, Artifact Registry and the IAM
// Credentials API. Requests need a token it issued. Operations finish after one look. failNext() makes the next
// matching call fail as Google would.
import http from 'node:http';
import crypto from 'node:crypto';

export async function createFakeGcp({ project = 'test-project', regions }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = `noobly@${project}.iam.gserviceaccount.com`;
  const state = { networks: new Map(), subnets: new Map(), addresses: new Map(), instances: new Map(), firewalls: new Map(), ops: new Map(), repos: new Map(), images: [], tokens: new Set(), calls: [] };
  const failures = [];
  let n = 0;
  let url = '';
  const opId = () => `operation-${(n += 1)}`;

  function op(scope, apply) {
    const name = opId();
    const where = scope.startsWith('zones/') ? { zone: `${url}/compute/v1/projects/${project}/${scope}` } : scope.startsWith('regions/') ? { region: `${url}/compute/v1/projects/${project}/${scope}` } : {};
    state.ops.set(`${scope}/${name}`, { name, ...where, status: 'RUNNING', progress: 0, looks: 0, apply });
    return { kind: 'compute#operation', name, ...where, status: 'RUNNING', progress: 0 };
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, message, reason = 'invalid') => send(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

  function verifyJwt(assertion) {
    const [head, claims, sig] = String(assertion).split('.');
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(sig ?? '', 'base64url'))) return null;
    const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
    return c.iss === email && c.aud === `${url}/token` && String(c.scope).includes('cloud-platform') ? c : null;
  }

  const zonesOf = (region) => regions.find((r) => r.id === region)?.zones ?? [];
  const last = (s) => String(s).split('/').pop();
  const instanceView = (vm) => ({ ...vm, zone: `${url}/compute/v1/projects/${project}/zones/${vm.zoneName}`, machineType: `${url}/compute/v1/projects/${project}/zones/${vm.zoneName}/machineTypes/${vm.type}` });

  async function route(req, res, body) {
    const u = new URL(req.url, url);
    const p = decodeURIComponent(u.pathname);
    const m = (re) => re.exec(p);
    state.calls.push(`${req.method} ${p}`);
    const fail = failures.findIndex((f) => f.method === req.method && f.path.test(p));
    if (fail >= 0) {
      const [f] = failures.splice(fail, 1);
      return send(res, f.status, f.body);
    }

    if (req.method === 'POST' && p === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !verifyJwt(form.get('assertion'))) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const token = `ya29.fake-${(n += 1)}`;
      state.tokens.add(token);
      return send(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.tokens.has(bearer)) return error(res, 401, 'Request had invalid authentication credentials.', 'authError');
    const json = body ? JSON.parse(body) : {};

    // IAM Credentials: a token for the reader service account.
    let r = m(/^\/iam\/v1\/projects\/-\/serviceAccounts\/([^:]+):generateAccessToken$/);
    if (r && req.method === 'POST') {
      if (r[1] !== `noobly-pull@${project}.iam.gserviceaccount.com`) return error(res, 404, `Service account ${r[1]} not found.`, 'notFound');
      state.tokens.add('ya29.reader');
      return send(res, 200, { accessToken: 'ya29.reader', expireTime: new Date(Date.now() + 3600_000).toISOString() });
    }

    // Cloud Monitoring.
    if (p === `/v3/projects/${project}/timeSeries`) {
      const id = /instance_id="(\d+)"/.exec(u.searchParams.get('filter') ?? '')?.[1];
      const vm = [...state.instances.values()].find((v) => v.id === id);
      return send(res, 200, vm ? { timeSeries: [{ points: [{ value: { doubleValue: 0.23 } }] }] } : {});
    }

    // Artifact Registry.
    const ar = `/ar/v1/projects/${project}/locations`;
    if ((r = m(new RegExp(`^${ar}/([a-z0-9-]+)/repositories$`))) && req.method === 'POST') {
      const id = `${r[1]}/${u.searchParams.get('repositoryId')}`;
      if (state.repos.has(id)) return error(res, 409, 'the repository already exists', 'alreadyExists');
      state.repos.set(id, { format: json.format, labels: json.labels });
      return send(res, 200, { name: `projects/${project}/locations/${r[1]}/operations/ar-${(n += 1)}`, done: false });
    }
    if ((r = m(new RegExp(`^/ar/v1/projects/${project}/locations/([a-z0-9-]+)/operations/(.+)$`)))) return send(res, 200, { name: r[2], done: true });
    if ((r = m(new RegExp(`^${ar}/([a-z0-9-]+)/repositories/([^/]+)/dockerImages$`)))) {
      return send(res, 200, { dockerImages: state.images.filter((i) => i.region === r[1] && i.repo === r[2]).map((i) => ({ uri: `${r[1]}-docker.pkg.dev/${project}/${r[2]}/${i.pkg}@${i.digest}`, tags: i.tags, uploadTime: i.uploadTime })) });
    }
    if ((r = m(new RegExp(`^${ar}/([a-z0-9-]+)/repositories/([^/]+)/packages/(.+)/tags/([^/]+)$`)))) {
      const img = state.images.find((i) => i.region === r[1] && i.repo === r[2] && i.pkg === r[3] && i.tags.includes(r[4]));
      if (!img) return error(res, 404, 'tag not found', 'notFound');
      return send(res, 200, { name: p, version: `projects/${project}/locations/${r[1]}/repositories/${r[2]}/packages/${r[3]}/versions/${img.digest}` });
    }
    if ((r = m(new RegExp(`^${ar}/([a-z0-9-]+)/repositories/([^/]+)/packages/(.+)/versions/([^/]+)$`))) && req.method === 'DELETE') {
      state.images = state.images.filter((i) => !(i.region === r[1] && i.repo === r[2] && i.pkg === r[3] && i.digest === r[4]));
      return send(res, 200, { done: true });
    }

    // Compute Engine.
    const base = `/compute/v1/projects/${project}`;
    if (p === base) return send(res, 200, { name: project, kind: 'compute#project' });
    if (!p.startsWith(base)) return error(res, 404, `Unknown path ${p}`, 'notFound');
    const q = p.slice(base.length);

    if ((r = /^\/(zones\/[^/]+|regions\/[^/]+|global)\/operations\/(.+)$/.exec(q))) {
      const o = state.ops.get(`${r[1]}/${r[2]}`);
      if (!o) return error(res, 404, 'operation not found', 'notFound');
      o.looks += 1;
      if (o.looks >= 2 && o.status !== 'DONE') {
        o.status = 'DONE';
        o.progress = 100;
        o.apply?.();
      } else if (o.status !== 'DONE') o.progress = 50;
      return send(res, 200, { name: o.name, status: o.status, progress: o.progress, zone: o.zone, region: o.region });
    }
    if (q === '/regions') return send(res, 200, { items: regions.map((x) => ({ name: x.id, status: 'UP', zones: x.zones.map((z) => `${url}${base}/zones/${z}`) })) });
    if ((r = /^\/regions\/([^/]+)$/.exec(q))) {
      if (!zonesOf(r[1]).length) return error(res, 404, `The resource 'regions/${r[1]}' was not found`, 'notFound');
      return send(res, 200, { name: r[1], zones: zonesOf(r[1]).map((z) => `${url}${base}/zones/${z}`) });
    }
    if ((r = /^\/zones\/([^/]+)\/machineTypes$/.exec(q))) {
      return send(res, 200, { items: [['e2-small', 2, 2048], ['e2-medium', 2, 4096], ['e2-standard-2', 2, 8192], ['e2-standard-4', 4, 16384], ['e2-standard-8', 8, 32768]].map(([name, guestCpus, memoryMb]) => ({ name, guestCpus, memoryMb })) });
    }

    // Networks and subnetworks.
    if (q === '/global/networks' && req.method === 'POST') {
      if (state.networks.has(json.name)) return error(res, 409, 'already exists', 'alreadyExists');
      return send(res, 200, op('global', () => state.networks.set(json.name, { name: json.name, autoCreateSubnetworks: json.autoCreateSubnetworks })));
    }
    if ((r = /^\/global\/networks\/([^/]+)$/.exec(q))) return state.networks.has(r[1]) ? send(res, 200, state.networks.get(r[1])) : error(res, 404, `network ${r[1]} not found`, 'notFound');
    if ((r = /^\/regions\/([^/]+)\/subnetworks$/.exec(q)) && req.method === 'POST') {
      if (!state.networks.has(last(json.network))) return error(res, 400, 'The network does not exist.', 'invalid');
      return send(res, 200, op(`regions/${r[1]}`, () => state.subnets.set(`${r[1]}/${json.name}`, { name: json.name, ipCidrRange: json.ipCidrRange, network: json.network })));
    }
    if ((r = /^\/regions\/([^/]+)\/subnetworks\/([^/]+)$/.exec(q))) {
      const s = state.subnets.get(`${r[1]}/${r[2]}`);
      return s ? send(res, 200, s) : error(res, 404, 'subnetwork not found', 'notFound');
    }

    // Addresses.
    if ((r = /^\/regions\/([^/]+)\/addresses$/.exec(q)) && req.method === 'POST') {
      const id = `${r[1]}/${json.name}`;
      if (state.addresses.has(id)) return error(res, 409, 'already exists', 'alreadyExists');
      const ip = `203.0.113.${10 + state.addresses.size}`;
      return send(res, 200, op(`regions/${r[1]}`, () => state.addresses.set(id, { name: json.name, address: ip, labels: json.labels ?? {}, status: 'RESERVED', region: `${url}${base}/regions/${r[1]}` })));
    }
    if ((r = /^\/regions\/([^/]+)\/addresses\/([^/]+)$/.exec(q))) {
      const id = `${r[1]}/${r[2]}`;
      if (!state.addresses.has(id)) return error(res, 404, 'address not found', 'notFound');
      if (req.method === 'DELETE') return send(res, 200, op(`regions/${r[1]}`, () => state.addresses.delete(id)));
      return send(res, 200, state.addresses.get(id));
    }
    if (q === '/aggregated/addresses') {
      const items = {};
      for (const [id, a] of state.addresses) (items[`regions/${id.split('/')[0]}`] ??= { addresses: [] }).addresses.push(a);
      return send(res, 200, { items });
    }

    // Instances.
    if ((r = /^\/zones\/([^/]+)\/instances$/.exec(q)) && req.method === 'POST') {
      const zone = r[1];
      if ([...state.instances.values()].some((v) => v.name === json.name)) return error(res, 409, `The resource 'projects/${project}/zones/${zone}/instances/${json.name}' already exists`, 'alreadyExists');
      const type = last(json.machineType);
      if (!['e2-small', 'e2-medium', 'e2-standard-2', 'e2-standard-4', 'e2-standard-8'].includes(type)) return error(res, 400, `Invalid value for field 'resource.machineType': '${json.machineType}'.`);
      const subnet = /regions\/([^/]+)\/subnetworks\/([^/]+)$/.exec(json.networkInterfaces?.[0]?.subnetwork ?? '');
      if (!subnet || !state.subnets.has(`${subnet[1]}/${subnet[2]}`)) return error(res, 400, 'The subnetwork does not exist.');
      const natIP = json.networkInterfaces[0].accessConfigs?.[0]?.natIP ?? `34.0.0.${state.instances.size + 1}`;
      const vm = {
        id: String(1000000 + state.instances.size), name: json.name, zoneName: zone, type, status: 'PROVISIONING', labels: json.labels ?? {}, tags: json.tags,
        networkInterfaces: [{ networkIP: `10.128.0.${state.instances.size + 2}`, accessConfigs: [{ natIP }] }], metadata: json.metadata, disks: json.disks,
      };
      for (const a of state.addresses.values()) if (a.address === natIP) a.status = 'IN_USE';
      state.instances.set(`${zone}/${json.name}`, vm);
      return send(res, 200, op(`zones/${zone}`, () => { vm.status = 'RUNNING'; }));
    }
    if ((r = /^\/zones\/([^/]+)\/instances\/([^/]+)(?:\/(start|stop|reset))?$/.exec(q))) {
      const id = `${r[1]}/${r[2]}`;
      const vm = state.instances.get(id);
      if (!vm) return error(res, 404, `The resource 'projects/${project}/zones/${r[1]}/instances/${r[2]}' was not found`, 'notFound');
      if (req.method === 'GET' && !r[3]) return send(res, 200, instanceView(vm));
      if (req.method === 'DELETE') {
        vm.status = 'STOPPING';
        return send(res, 200, op(`zones/${r[1]}`, () => state.instances.delete(id)));
      }
      const [during, after] = { start: ['STAGING', 'RUNNING'], stop: ['STOPPING', 'TERMINATED'], reset: ['STAGING', 'RUNNING'] }[r[3]];
      vm.status = during;
      return send(res, 200, op(`zones/${r[1]}`, () => { vm.status = after; }));
    }
    if (q === '/aggregated/instances') {
      const items = {};
      for (const vm of state.instances.values()) (items[`zones/${vm.zoneName}`] ??= { instances: [] }).instances.push(instanceView(vm));
      return send(res, 200, { items });
    }

    // Firewalls.
    if (q === '/global/firewalls' && req.method === 'POST') {
      if (state.firewalls.has(json.name)) return error(res, 409, 'already exists', 'alreadyExists');
      state.firewalls.set(json.name, json);
      return send(res, 200, op('global', null));
    }
    if (q === '/global/firewalls') return send(res, 200, { items: [...state.firewalls.values()] });
    if ((r = /^\/global\/firewalls\/([^/]+)$/.exec(q))) {
      if (!state.firewalls.has(r[1])) return error(res, 404, 'firewall not found', 'notFound');
      if (req.method === 'DELETE') state.firewalls.delete(r[1]);
      else if (req.method === 'PATCH') Object.assign(state.firewalls.get(r[1]), json);
      return send(res, 200, op('global', null));
    }
    return error(res, 404, `Unknown path ${p}`, 'notFound');
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => route(req, res, body).catch((err) => error(res, 500, err.message, 'backendError')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    project,
    state,
    /** The service account key, as a person would paste it. */
    key: { type: 'service_account', project_id: project, private_key_id: 'abc', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: email, token_uri: `${url}/token` },
    endpoints: { compute: `${url}/compute/v1`, monitoring: `${url}/v3`, artifactregistry: `${url}/ar/v1`, iamcredentials: `${url}/iam/v1` },
    /** The next `method` call to a path matching `path` answers `status` with Google's error body. */
    failNext(method, path, status, message, reason) {
      failures.push({ method, path, status, body: { error: { code: status, message, status: reason, errors: [{ reason, message }] } } });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
