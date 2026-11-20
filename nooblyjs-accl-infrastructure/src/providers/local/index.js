// The local provider (spec 8.9, "Provider: local"; task 8.9.4): the provider contract over a local site, so the
// screens and services that speak to clouds can speak to your own servers too. A site is one region with one zone;
// its enrolled servers are the VMs. Servers are enrolled, not created, and you restart them yourself, so those calls
// are refused in plain words. metrics.vm comes from the agent's stats stream (8.9.9).
import { CloudError } from '../errors.js';
import { hasLabels } from '../contract.js';

const ENROLLED = 'Local servers are enrolled, not created. Use Add server on the Platform page.';
const BY_HAND = 'Restart the server yourself; the agent reconnects when it is back.';
const NO_PUBLIC = 'Local sites are LAN only for now: there are no public addresses or firewall rules to set.';

/**
 * @param {object} o
 * @param {string} o.site                                   the site id (the account's region)
 * @param {ReturnType<import('../../platform/local.js').createLocalServers>} o.servers
 * @param {{ isOnline: (id: string) => boolean }} o.hub
 * @param {{ serverStats: (id: string) => object | null }} [o.runtime]
 */
export function createLocalProvider({ site, servers, hub, runtime = null }) {
  const siteOf = async () => {
    const s = await servers.site(site);
    if (!s) throw new CloudError('not_found', `There is no local site ${site}.`);
    return s;
  };
  /** A server as the contract's VM. */
  const asVm = (s) => ({
    id: s.id, kind: 'vm', name: s.hostname, region: s.site, zone: s.site, machineType: 'local',
    status: hub.isOnline(s.id) ? 'running' : 'offline',
    privateIp: s.facts?.addresses?.[0] ?? null, publicIp: null,
    vcpu: s.facts?.cpus ?? null, memoryGb: s.facts?.memoryMb ? Math.round(s.facts.memoryMb / 102.4) / 10 : null,
    allocatable: s.allocatable ?? null, warnings: s.warnings ?? [], agentVersion: s.agentVersion ?? null,
    labels: { 'noobly-site': s.site }, createdAt: s.enrolledAt ?? null,
  });
  const mine = async () => (await servers.servers({ site })).map(asVm);
  const refuse = (message) => async () => { throw new CloudError('invalid', message); };

  const compute = {
    create: refuse(ENROLLED),
    remove: refuse(ENROLLED),
    start: refuse(BY_HAND),
    stop: refuse(BY_HAND),
    restart: refuse(BY_HAND),
    reserveAddress: refuse(NO_PUBLIC),
    releaseAddress: refuse(NO_PUBLIC),
    setFirewall: refuse(NO_PUBLIC),
    async get(ref) {
      const s = await servers.server(ref);
      return s && s.site === site && s.status !== 'removed' ? asVm(s) : null;
    },
    async list({ labels = {} } = {}) {
      return (await mine()).filter((v) => hasLabels(v, labels));
    },
    /** A server's address on the LAN (the first one it reports). */
    async defaultAddress(ref) {
      return (await compute.get(ref))?.privateIp ?? null;
    },
  };

  return {
    name: 'local',
    cloud: 'local',
    account: {
      /** At least one online server. */
      async verify() {
        const s = await siteOf();
        const online = (await mine()).filter((v) => v.status === 'running').length;
        return online
          ? { ok: true, identity: `local site ${s.name} (${online} server${online === 1 ? '' : 's'} online)` }
          : { ok: false, message: `No server of ${s.name} is online. Start its agent, or add a server.` };
      },
      async regions() {
        const s = await siteOf();
        return [{ id: s.id, label: s.name, zones: [s.id] }];
      },
      async zones(id) {
        if (id !== site) throw new CloudError('invalid', `This local site is ${site}, not ${id}.`);
        return [site];
      },
      // Tenant networks are Docker networks the local runtime makes on each server; the site itself is the LAN.
      async detectNetwork(id) {
        await siteOf();
        return id === site ? `lan:${site}` : null;
      },
      async ensureNetwork(id) {
        if (id !== site) throw new CloudError('invalid', `This local site is ${site}, not ${id}.`);
        await siteOf();
        return { ref: `lan:${site}`, operation: null, created: false };
      },
    },
    catalog: {
      async machineTypes() { return []; },
      async images() { return []; },
    },
    compute,
    metrics: {
      /** The server's latest 10 s totals from its agent: CPU as a percentage of its CPUs, and memory used. */
      async vm(ref, window = 'now') {
        const s = await servers.server(ref);
        if (!s || s.site !== site) throw new CloudError('not_found', `Site ${site} has no server ${ref}.`);
        const latest = hub.isOnline(ref) ? runtime?.serverStats(ref) ?? null : null;
        if (!latest) return { window, cpuPercent: null, memoryMb: null, at: null };
        const cpus = s.facts?.cpus || 1;
        return { window, cpuPercent: Math.round((latest.cpu / cpus) * 1000) / 10, memoryMb: latest.memoryMb, instances: latest.instances, at: latest.at };
      },
    },
    async inventory({ labels = {} } = {}) {
      return { vms: await compute.list({ labels }), databases: [], buckets: [], networks: [], addresses: [] };
    },
    /** Nothing a local provider does is long cloud work. */
    async waitFor() {},
  };
}
