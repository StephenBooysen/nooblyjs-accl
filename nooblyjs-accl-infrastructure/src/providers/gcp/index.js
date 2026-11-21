// The GCP provider (architecture.md §6.2; roadmap 2.8, 2.10, spec 8.3.3): the provider contract over Google's REST
// APIs with a service account key, and no SDK: Compute Engine (network, subnetworks, instances, static addresses,
// firewall rules, machine types), Cloud Monitoring (CPU) and Artifact Registry (images).
//
// - One VPC network `noobly-cloud` (custom subnet mode) per project, and one subnetwork per region, `noobly-cloud`,
//   10.<128+i>.0.0/20 where i is the region's place in the catalogue. The network ref is the subnetwork's path.
// - Refs are paths: zones/<zone>/instances/<name>, regions/<region>/addresses/<name>.
// - A VM's firewall is one rule per port, `noobly-<vm>-<port>`, aimed at the network tag `noobly-<vm>`.
// - GCP networks carry no labels, so the network is found by its name; instances and addresses carry the labels, and
//   lists are filtered by them here (a label key with a hyphen is awkward in a list filter).
// - Long work returns { kind: 'gcp', scope, name } (a zone, region or global operation); waitFor polls it.
// - Registry: pushes use the service account's own token; pulls a token minted for the reader service account
//   `noobly-pull@<project>.iam.gserviceaccount.com` (or `pullServiceAccount` in the key's JSON), so hosts can only
//   read. That needs the Service Account Token Creator role on the reader (docs/least-privilege.md).
import { CloudError } from '../errors.js';
import { hasLabels } from '../contract.js';
import { readServiceAccount, googleToken } from '../http/google-auth.js';

const DEFAULTS = {
  compute: 'https://compute.googleapis.com/compute/v1',
  monitoring: 'https://monitoring.googleapis.com/v3',
  artifactregistry: 'https://artifactregistry.googleapis.com/v1',
  iamcredentials: 'https://iamcredentials.googleapis.com/v1',
};
const NETWORK = 'noobly-cloud';
const STATUS = {
  PROVISIONING: 'provisioning', STAGING: 'provisioning', REPAIRING: 'provisioning', RUNNING: 'running',
  STOPPING: 'stopping', SUSPENDING: 'stopping', TERMINATED: 'stopped', STOPPED: 'stopped', SUSPENDED: 'stopped',
};
const last = (url) => String(url ?? '').split('/').pop();
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/** Google's error, in plain words, as a CloudError. */
export function googleError(status, body, what = 'Google Cloud') {
  const e = body?.error ?? {};
  const reason = e.errors?.[0]?.reason ?? e.status ?? '';
  const message = e.message ? `${what}: ${e.message}` : null;
  if (status === 401) return new CloudError('permission', `${what} no longer accepts the service account key.`);
  if (status === 403 && /quota|rateLimit/i.test(reason)) return new CloudError('quota', message ?? `${what} says a quota is used up.`);
  if (status === 403) return new CloudError('permission', message ?? `The service account is missing a permission in ${what}.`);
  if (status === 404) return new CloudError('not_found', message ?? `${what} has no such resource.`);
  if (status === 409) return new CloudError('conflict', message ?? 'That name is taken in the project.');
  if (status === 429 || /QUOTA|quotaExceeded|ZONE_RESOURCE_POOL_EXHAUSTED/i.test(reason)) return new CloudError('quota', message ?? `${what} says a quota is used up.`);
  if (status >= 500) return new CloudError('unavailable', `${what} is not answering (${status}).`);
  return new CloudError('invalid', message ?? `${what} refused the request (${status}).`);
}

/**
 * @param {object} o
 * @param {object} o.account       the account record (projectId)
 * @param {*} o.credentials        the service account key (JSON text or object)
 * @param {object} o.catalog       GCP's catalogue (regions, zones, machine types, images)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {Partial<typeof DEFAULTS>} [o.endpoints]   API base URLs (tests point them at a fake)
 * @param {number} [o.pollMs]      how often waitFor looks at an operation
 * @param {() => number} [o.now]
 */
export function createGcpProvider({ account, credentials, catalog, fetchImpl = fetch, endpoints = {}, pollMs = 2000, now = () => Date.now() }) {
  const key = readServiceAccount(credentials);
  const project = account.projectId ?? key.projectId;
  if (!project) throw new CloudError('invalid', 'Give the GCP project ID.');
  const api = { ...DEFAULTS, ...endpoints };
  const token = googleToken({ key, fetchImpl, now });
  const base = `${api.compute}/projects/${project}`;
  const pullAccount = (typeof credentials === 'object' ? credentials?.pullServiceAccount : null) ?? `noobly-pull@${project}.iam.gserviceaccount.com`;

  async function call(method, url, { body, allow = [], what } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${await token()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (err instanceof CloudError) throw err;
      throw new CloudError('unavailable', 'Google Cloud is not answering.');
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (allow.includes(res.status)) return { status: res.status, data };
    if (!res.ok) throw googleError(res.status, data, what);
    return { status: res.status, data };
  }
  const get = async (url, opts) => (await call('GET', url, opts)).data;
  /** Every page of a list (items, or an aggregated list's items per scope). */
  async function all(url, field = 'items') {
    const out = [];
    let pageToken = null;
    do {
      const u = new URL(url);
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const page = await get(u.toString());
      if (field === 'aggregated') for (const scoped of Object.values(page.items ?? {})) out.push(...(scoped.instances ?? scoped.addresses ?? []));
      else out.push(...(page[field] ?? []));
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }
  /** A compute operation's handle. */
  const handle = (op) => {
    if (!op?.name) return null;
    const scope = op.zone ? `zones/${last(op.zone)}` : op.region ? `regions/${last(op.region)}` : 'global';
    return { kind: 'gcp', scope, name: op.name };
  };

  const regionInfo = (id) => {
    const r = catalog.regions.find((x) => x.id === id);
    if (!r) throw new CloudError('invalid', `${catalog.short} has no region ${id} here.`);
    return r;
  };
  const regionOfZone = (zone) => catalog.regions.find((r) => r.zones.includes(zone)) ?? null;
  const subnetRef = (region) => `regions/${region}/subnetworks/${NETWORK}`;
  const cidrOf = (region) => `10.${128 + catalog.regions.findIndex((r) => r.id === region)}.0.0/20`;
  const tagOf = (name) => `noobly-${name}`.slice(0, 63);
  const ruleName = (name, port) => `noobly-${name}-${port}`.slice(0, 63);

  async function rulesOf(name) {
    const rules = await all(`${base}/global/firewalls`);
    return rules.filter((r) => r.targetTags?.includes(tagOf(name)) && r.name.startsWith(`noobly-${name}-`));
  }

  async function shape(vm) {
    const nic = vm.networkInterfaces?.[0] ?? {};
    const rules = await rulesOf(vm.name);
    const firewall = rules.flatMap((r) => (r.allowed ?? []).flatMap((a) => (a.ports ?? []).flatMap((p) => (r.sourceRanges ?? []).map((from) => ({ port: Number(p), from })))))
      .sort((a, b) => a.port - b.port || a.from.localeCompare(b.from));
    const zone = last(vm.zone);
    return {
      id: `zones/${zone}/instances/${vm.name}`, kind: 'vm', name: vm.name, zone, region: regionOfZone(zone)?.id ?? zone.replace(/-[a-z]$/, ''),
      machineType: last(vm.machineType), status: STATUS[vm.status] ?? vm.status?.toLowerCase(), publicIp: nic.accessConfigs?.[0]?.natIP ?? null,
      privateIp: nic.networkIP ?? null, firewall, labels: vm.labels ?? {}, instanceId: vm.id ?? null, createdAt: vm.creationTimestamp ?? null,
    };
  }

  async function addressIp(ref) {
    const a = await get(`${base}/${ref}`);
    return a.address ?? null;
  }

  const accountApi = {
    async verify() {
      try {
        await get(base);
        return { ok: true, identity: `${key.clientEmail} on project ${project}` };
      } catch (err) {
        if (err instanceof CloudError && ['permission', 'not_found', 'invalid'].includes(err.code)) return { ok: false, message: err.code === 'not_found' ? `There is no project ${project}, or the service account can’t see it.` : err.message };
        throw err;
      }
    },
    /** The catalogue's regions this project can use (each with its zones that are up). */
    async regions() {
      const live = new Map((await all(`${base}/regions`)).map((r) => [r.name, r]));
      return catalog.regions.filter((r) => live.has(r.id)).map((r) => ({
        id: r.id, label: r.label, zones: (live.get(r.id).zones ?? []).map(last).filter((z) => r.zones.includes(z)),
      }));
    },
    async zones(region) {
      regionInfo(region);
      const r = await get(`${base}/regions/${region}`, { what: 'Compute Engine' });
      return (r.zones ?? []).map(last).sort();
    },
    async detectNetwork(region) {
      const { status } = await call('GET', `${base}/${subnetRef(region)}`, { allow: [404] });
      return status === 404 ? null : subnetRef(region);
    },
    /** The `noobly-cloud` network (made once per project) and its subnetwork in the region (made once per region). */
    async ensureNetwork(region, { labels = {} } = {}) {
      regionInfo(region);
      const net = await call('GET', `${base}/global/networks/${NETWORK}`, { allow: [404] });
      if (net.status === 404) {
        const { data } = await call('POST', `${base}/global/networks`, { body: { name: NETWORK, autoCreateSubnetworks: false, description: `Noobly Cloud (${labels['noobly-install'] ?? 'install'})` }, allow: [409] });
        await waitFor(handle(data));
      }
      const sub = await call('GET', `${base}/${subnetRef(region)}`, { allow: [404] });
      if (sub.status !== 404) return { ref: subnetRef(region), operation: null, created: false };
      const { data } = await call('POST', `${base}/regions/${region}/subnetworks`, {
        body: { name: NETWORK, network: `projects/${project}/global/networks/${NETWORK}`, ipCidrRange: cidrOf(region), description: 'Noobly Cloud' },
        allow: [409],
      });
      return { ref: subnetRef(region), operation: handle(data), created: true };
    },
  };

  const compute = {
    /** spec: { name, zone, machineType, image, diskGb, labels, userData, address?, network? } */
    async create(spec) {
      const where = regionOfZone(spec.zone);
      if (!where) throw new CloudError('invalid', `${catalog.short} has no zone ${spec.zone} here.`);
      if (!catalog.machineTypes[spec.machineType]) throw new CloudError('invalid', `${catalog.short} has no machine type ${spec.machineType} here.`);
      const image = catalog.images.find((i) => i.id === spec.image) ?? catalog.images[0];
      const [imageProject, family] = image.source.split('/');
      const natIP = spec.address ? await addressIp(spec.address) : null;
      const body = {
        name: spec.name,
        machineType: `zones/${spec.zone}/machineTypes/${spec.machineType}`,
        labels: spec.labels ?? {},
        tags: { items: [tagOf(spec.name)] },
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: `projects/${imageProject}/global/images/family/${family}`, diskSizeGb: String(spec.diskGb ?? catalog.disk.minGb), diskType: `zones/${spec.zone}/diskTypes/pd-balanced` } }],
        networkInterfaces: [{
          subnetwork: `projects/${project}/${spec.network ?? subnetRef(where.id)}`,
          accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT', ...(natIP ? { natIP } : {}) }],
        }],
        metadata: { items: spec.userData ? [{ key: 'user-data', value: spec.userData }] : [] },
      };
      const { status, data } = await call('POST', `${base}/zones/${spec.zone}/instances`, { body, allow: [409] });
      if (status === 409) throw new CloudError('conflict', `There is already a VM called ${spec.name} in project ${project}.`);
      return { ref: `zones/${spec.zone}/instances/${spec.name}`, operation: handle(data) };
    },
    async get(ref) {
      const { status, data } = await call('GET', `${base}/${ref}`, { allow: [404] });
      return status === 404 ? null : shape(data);
    },
    async list({ labels = {} } = {}) {
      const vms = (await all(`${base}/aggregated/instances`, 'aggregated')).filter((v) => hasLabels(v, labels));
      return Promise.all(vms.map(shape));
    },
    start: async (ref) => ({ ref, operation: handle((await call('POST', `${base}/${ref}/start`)).data) }),
    stop: async (ref) => ({ ref, operation: handle((await call('POST', `${base}/${ref}/stop`)).data) }),
    restart: async (ref) => ({ ref, operation: handle((await call('POST', `${base}/${ref}/reset`)).data) }),
    /** Deletes the instance and its firewall rules (the rules go in the background). */
    async remove(ref) {
      const name = last(ref);
      const { status, data } = await call('DELETE', `${base}/${ref}`, { allow: [404] });
      for (const rule of await rulesOf(name)) await call('DELETE', `${base}/global/firewalls/${rule.name}`, { allow: [404] });
      return { ref, operation: status === 404 ? null : handle(data) };
    },
    async reserveAddress(region, { labels = {} } = {}) {
      regionInfo(region);
      const name = `noobly-${labels['noobly-name'] ?? 'vm'}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 63);
      const { data } = await call('POST', `${base}/regions/${region}/addresses`, { body: { name, labels, description: 'Noobly Cloud' } });
      await waitFor(handle(data));
      const ref = `regions/${region}/addresses/${name}`;
      return { ref, address: await addressIp(ref), operation: null };
    },
    async releaseAddress(ref) {
      const { status, data } = await call('DELETE', `${base}/${ref}`, { allow: [404] });
      return { ref, operation: status === 404 ? null : handle(data) };
    },
    /** rules: [{ port, from }]: replaces the VM's inbound rules (one firewall rule per port). */
    async setFirewall(ref, rules = []) {
      const name = last(ref);
      const byPort = new Map();
      for (const r of rules) byPort.set(Number(r.port), [...(byPort.get(Number(r.port)) ?? []), r.from]);
      const existing = new Map((await rulesOf(name)).map((r) => [r.name, r]));
      for (const [port, from] of byPort) {
        const id = ruleName(name, port);
        const body = { name: id, network: `projects/${project}/global/networks/${NETWORK}`, direction: 'INGRESS', allowed: [{ IPProtocol: 'tcp', ports: [String(port)] }], sourceRanges: [...new Set(from)].sort(), targetTags: [tagOf(name)], description: 'Noobly Cloud' };
        if (existing.has(id)) {
          const had = existing.get(id);
          if (JSON.stringify([...(had.sourceRanges ?? [])].sort()) !== JSON.stringify(body.sourceRanges)) await call('PATCH', `${base}/global/firewalls/${id}`, { body: { sourceRanges: body.sourceRanges } });
          existing.delete(id);
        } else {
          await call('POST', `${base}/global/firewalls`, { body, allow: [409] });
        }
      }
      for (const stale of existing.keys()) await call('DELETE', `${base}/global/firewalls/${stale}`, { allow: [404] });
      return { ref, operation: null };
    },
    /** GCP gives a VM no public hostname: its address is its IP. */
    async defaultAddress(ref) {
      return (await compute.get(ref))?.publicIp ?? null;
    },
  };

  /** Waits for a compute operation (or an Artifact Registry one, kind gcp-lro). */
  async function waitFor(h, { signal, onProgress } = {}) {
    if (!h) return;
    for (;;) {
      const op = h.kind === 'gcp-lro' ? await get(`${api.artifactregistry}/${h.name}`) : await get(`${base}/${h.scope}/operations/${h.name}`);
      const done = h.kind === 'gcp-lro' ? op.done === true : op.status === 'DONE';
      if (done) {
        const err = h.kind === 'gcp-lro' ? op.error : op.error?.errors?.[0];
        if (err) {
          const code = err.code ?? err.reason ?? '';
          throw googleError(/QUOTA|EXHAUSTED/i.test(code) ? 429 : /NOT_FOUND/i.test(code) ? 404 : /ALREADY_EXISTS/i.test(code) ? 409 : /PERMISSION|FORBIDDEN/i.test(code) ? 403 : 400, { error: { message: err.message, status: code } });
        }
        return;
      }
      if (typeof op.progress === 'number') onProgress?.(Math.min(0.99, op.progress / 100));
      await sleep(pollMs, signal);
    }
  }

  const registryHost = (region) => `${region}-docker.pkg.dev`;
  const repoUrl = (region, name) => `${api.artifactregistry}/projects/${project}/locations/${region}/repositories/${name}`;
  /** A path or image ref: <region>-docker.pkg.dev/<project>/<repo>[/<image, which may hold slashes>[:<tag>]]. */
  const parsePath = (path) => {
    const m = /^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/:]+)(?:\/([^:]+))?(?::([\w][\w.-]{0,127}))?$/.exec(path);
    if (!m) throw new CloudError('invalid', `${path} is not an Artifact Registry path.`);
    return { region: m[1], repo: m[3], image: m[4] ?? null, tag: m[5] ?? null };
  };

  const registry = {
    async ensure(region, { name, labels = {} } = {}) {
      regionInfo(region);
      if (!/^[a-z][a-z0-9-]{1,62}$/.test(name ?? '')) throw new CloudError('invalid', 'A repository name is lower-case letters, digits and hyphens.');
      const { status, data } = await call('POST', `${api.artifactregistry}/projects/${project}/locations/${region}/repositories?repositoryId=${name}`, { body: { format: 'DOCKER', labels, description: 'Noobly Cloud images' }, allow: [409], what: 'Artifact Registry' });
      if (status !== 409 && data.name && !data.done) await waitFor({ kind: 'gcp-lro', name: data.name });
      const host = registryHost(region);
      return { host, path: `${host}/${project}/${name}` };
    },
    async pushCredentials(region) {
      regionInfo(region);
      return { server: registryHost(region), username: 'oauth2accesstoken', password: await token(), expiresAt: new Date(now() + 3000_000).toISOString() };
    },
    /** A token for the reader service account (Artifact Registry Reader only), minted by this one. */
    async pullCredentials(region) {
      regionInfo(region);
      const { data } = await call('POST', `${api.iamcredentials}/projects/-/serviceAccounts/${pullAccount}:generateAccessToken`, { body: { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s' }, what: `The reader service account ${pullAccount}` });
      return { server: registryHost(region), username: 'oauth2accesstoken', password: data.accessToken, expiresAt: data.expireTime };
    },
    async list(path) {
      const { region, repo } = parsePath(path);
      const images = await all(`${repoUrl(region, repo)}/dockerImages`, 'dockerImages');
      return images.flatMap((img) => {
        const [refNoDigest, digest] = img.uri.split('@');
        return (img.tags ?? []).map((tag) => ({ ref: `${refNoDigest}:${tag}`, tag, digest, pushedAt: img.uploadTime ?? img.updateTime ?? null, labels: {} }));
      }).sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
    },
    /** Deletes the version a tag points at (with every tag on it). */
    async remove(ref) {
      const { region, repo, image: pkg, tag } = parsePath(ref);
      if (!pkg || !tag) throw new CloudError('invalid', `${ref} names no image and tag.`);
      const t = await call('GET', `${repoUrl(region, repo)}/packages/${encodeURIComponent(pkg)}/tags/${encodeURIComponent(tag)}`, { allow: [404] });
      if (t.status === 404) return { ref, removed: false };
      await call('DELETE', `${api.artifactregistry}/${t.data.version}?force=true`, { allow: [404] });
      return { ref, removed: true };
    },
  };

  return {
    name: 'gcp',
    cloud: 'gcp',
    account: accountApi,
    registry,
    catalog: {
      /** The catalogue's machine types this zone offers. */
      async machineTypes(zone) {
        if (!regionOfZone(zone)) throw new CloudError('invalid', `${catalog.short} has no zone ${zone} here.`);
        const offered = new Map((await all(`${base}/zones/${zone}/machineTypes`)).map((m) => [m.name, m]));
        return Object.keys(catalog.machineTypes).filter((id) => offered.has(id)).map((id) => ({ id, vcpu: offered.get(id).guestCpus, memoryGb: offered.get(id).memoryMb / 1024 }));
      },
      /** The catalogue's images: public image families, always the latest image in each. */
      async images() {
        return catalog.images.map((i) => ({ id: i.id, label: i.label }));
      },
    },
    compute,
    metrics: {
      /** Mean CPU over the window, from Cloud Monitoring. */
      async vm(ref, window = '1h') {
        const vm = await compute.get(ref);
        if (!vm) throw new CloudError('not_found', `There is no VM ${last(ref)} in project ${project}.`);
        if (vm.status !== 'running' || !vm.instanceId) return { window, cpuPercent: null };
        const seconds = { '1h': 3600, '24h': 86400 }[window] ?? 3600;
        const u = new URL(`${api.monitoring}/projects/${project}/timeSeries`);
        u.searchParams.set('filter', `metric.type="compute.googleapis.com/instance/cpu/utilization" AND resource.labels.instance_id="${vm.instanceId}"`);
        u.searchParams.set('interval.startTime', new Date(now() - seconds * 1000).toISOString());
        u.searchParams.set('interval.endTime', new Date(now()).toISOString());
        u.searchParams.set('aggregation.alignmentPeriod', `${seconds}s`);
        u.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_MEAN');
        const data = await get(u.toString(), { what: 'Cloud Monitoring' });
        const value = data.timeSeries?.[0]?.points?.[0]?.value?.doubleValue;
        return { window, cpuPercent: typeof value === 'number' ? Math.round(value * 100) : null };
      },
    },
    async inventory({ labels = {} } = {}) {
      const [vms, addresses, net] = await Promise.all([
        compute.list({ labels }),
        all(`${base}/aggregated/addresses`, 'aggregated'),
        call('GET', `${base}/global/networks/${NETWORK}`, { allow: [404] }),
      ]);
      return {
        vms,
        addresses: addresses.filter((a) => hasLabels(a, labels)).map((a) => ({ id: `regions/${last(a.region)}/addresses/${a.name}`, kind: 'address', region: last(a.region), address: a.address, status: a.status?.toLowerCase(), labels: a.labels ?? {} })),
        networks: net.status === 404 ? [] : [{ id: `global/networks/${NETWORK}`, kind: 'network', name: NETWORK, status: 'ready', labels: {} }],
        databases: [],
        buckets: [],
      };
    },
    waitFor,
  };
}
