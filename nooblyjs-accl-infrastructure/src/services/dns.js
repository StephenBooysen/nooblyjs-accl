// Looking up a domain (roadmap 3.3, 6.x, 8.4.5): whether the A record a person was asked to add now points at their
// VM. Real accounts ask public resolvers (1.1.1.1, 8.8.8.8), never this machine's own, which may cache an old answer or
// see a split-horizon zone. Mock accounts ask the mock DNS: records in <dataDir>/mock-cloud/dns.yaml, which the seed
// story, the tests and a person demoing set, so the DNS job can be watched going Waiting → Verified offline.
import { Resolver } from 'node:dns/promises';

const FILE = ['mock-cloud', 'dns.yaml'];
const AWS_NAME = /^ec2-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.[a-z0-9-]+\.compute\.amazonaws\.com$/;
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string[]} [o.servers]   the resolvers real lookups ask (INFRA_DNS_SERVERS, comma-separated)
 */
export function createDns({ store, servers = (process.env.INFRA_DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean) }) {
  const read = async () => (await store.readYaml(FILE))?.records ?? {};

  /** The mock DNS: { host: ['203.0.113.5'] } or { host: { cname: 'other.host' } }. */
  const mock = {
    async lookup(host, depth = 0) {
      const name = String(host ?? '').toLowerCase();
      // The cloud's own name for an AWS VM answers with its address, as AWS's DNS does.
      const aws = AWS_NAME.exec(name);
      if (aws) return [aws.slice(1, 5).join('.')];
      const record = (await read())[name];
      if (!record) return [];
      if (Array.isArray(record)) return [...record];
      if (record.cname && depth < 5) return mock.lookup(record.cname, depth + 1);
      return [];
    },
    /** Sets an A record (a list of addresses) or a CNAME ({ cname }); null removes it. */
    async set(host, value) {
      await store.withLock(FILE, async () => {
        const records = await read();
        if (value === null) delete records[String(host).toLowerCase()];
        else records[String(host).toLowerCase()] = value;
        await store.writeYaml(FILE, { records });
      });
    },
    records: read,
  };

  const real = {
    async lookup(host) {
      const resolver = new Resolver({ timeout: 4000, tries: 2 });
      resolver.setServers(servers.length ? servers : PUBLIC_RESOLVERS);
      try {
        return await resolver.resolve4(host);
      } catch (err) {
        if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENONAME', 'NXDOMAIN'].includes(err.code)) return [];
        throw err;
      }
    },
  };

  return {
    /** The lookup for an account's resources: the mock DNS for a mock account, public DNS otherwise. */
    forAccount: (account) => (account?.provider === 'mock' ? mock : real),
    mock,
  };
}
