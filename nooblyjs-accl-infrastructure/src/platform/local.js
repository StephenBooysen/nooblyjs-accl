// Local servers (spec 8.9 R1, R2, R4, R12): sites, enrolled servers and one-time enrolment tokens, kept under
// local/ in the accelerator's store. Credentials and tokens are kept only as SHA-256 hashes. verify() is the agent
// hub's first-frame check: hello with a server's credential, or enrol with an unused, unexpired token.
import crypto from 'node:crypto';

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const SITE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const TOKEN_TTL_MS = 3_600_000;
export const DEFAULT_RESERVE = { cpu: 0.25, memoryMb: 512 };

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.config    installId()
 * @param {() => number} o.now
 * @param {{ warn: Function, info: Function }} o.log
 */
export function createLocalServers({ store, config, now, log }) {
  const iso = () => new Date(now()).toISOString();
  const siteFile = (id) => ['local', 'sites', `${id}.yaml`];
  const serverFile = (id) => ['local', 'servers', `${id}.yaml`];
  const enrolFile = (h) => ['local', 'enrolments', `${h}.yaml`];

  async function listYaml(dir) {
    const out = [];
    for (const f of (await store.list(dir)) ?? []) if (f.endsWith('.yaml')) {
      const r = await store.readYaml([...dir, f]).catch(() => null);
      if (r) out.push(r);
    }
    return out;
  }

  const publicServer = ({ credentialHash, ...s }) => s;

  const api = {
    async sites() {
      return (await listYaml(['local', 'sites'])).sort((a, b) => a.id.localeCompare(b.id));
    },
    site: (id) => (SITE_ID.test(id ?? '') ? store.readYaml(siteFile(id)) : null),

    /** R1: creates a site, or returns the one that exists. `bind` is where instances' ports listen (127.0.0.1 on one machine). */
    async ensureSite({ id, name, bind = '127.0.0.1', reserve = DEFAULT_RESERVE, ports = null, by = null }) {
      if (!SITE_ID.test(id ?? '')) throw new Error('A site id is lower-case letters, digits and hyphens, such as lan-dev.');
      return store.withLock(siteFile(id), async () => {
        const existing = await store.readYaml(siteFile(id));
        if (existing) return existing;
        const site = { id, name: name ?? id, mode: 'lan', bind, reserve, ...(ports ? { ports } : {}), status: 'active', createdAt: iso(), createdBy: by };
        await store.writeYaml(siteFile(id), site);
        log.info(`local site ${id} created`);
        return site;
      });
    },

    /** R1, for the operator's *Create site*: like ensureSite, but a site that exists already is refused. */
    async createSite(fields) {
      if (await api.site(fields.id)) {
        const err = new Error(`There is already a site ${fields.id}.`);
        err.code = 'exists';
        throw err;
      }
      return api.ensureSite(fields);
    },

    /** R2: a one-time enrolment token for a site, valid for an hour. Only its hash is kept. */
    async createEnrolment(siteId, { by = null } = {}) {
      if (!(await api.site(siteId))) throw new Error(`No site ${siteId}.`);
      const token = `enr_${crypto.randomBytes(32).toString('base64url')}`;
      await store.writeYaml(enrolFile(hash(token)), { site: siteId, createdAt: iso(), expiresAt: new Date(now() + TOKEN_TTL_MS).toISOString(), usedAt: null, server: null, createdBy: by });
      return { token, expiresAt: new Date(now() + TOKEN_TTL_MS).toISOString() };
    },

    async servers({ site } = {}) {
      return (await listYaml(['local', 'servers'])).filter((s) => s.status !== 'removed' && (!site || s.site === site)).map(publicServer)
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async server(id) {
      const s = /^srv_[a-z0-9]{8,32}$/.test(id ?? '') ? await store.readYaml(serverFile(id)) : null;
      return s ? publicServer(s) : null;
    },
    async update(id, patch) {
      return store.withLock(serverFile(id), async () => {
        const s = await store.readYaml(serverFile(id));
        if (!s) return null;
        const next = { ...s, ...patch };
        await store.writeYaml(serverFile(id), next);
        return publicServer(next);
      });
    },
    /** The hub's online/offline report. A removed server stays removed (its last disconnect comes after the removal). */
    async markStatus(id, status) {
      return store.withLock(serverFile(id), async () => {
        const s = await store.readYaml(serverFile(id));
        if (!s || s.status === 'removed') return null;
        const next = { ...s, status, lastSeenAt: iso() };
        await store.writeYaml(serverFile(id), next);
        return publicServer(next);
      });
    },
    /** R12: removes a server; its credential no longer works. */
    async remove(id) {
      return api.update(id, { status: 'removed', credentialHash: null, removedAt: iso() });
    },

    /** The hub's first-frame check. Resolves { server, install, credential? } or throws with the reason the agent sees. */
    async verify(frame) {
      const install = await config.installId();
      if (frame.type === 'hello') {
        const s = await store.readYaml(serverFile(frame.server)).catch(() => null);
        const given = hash(frame.credential);
        if (!s || s.status === 'removed' || !s.credentialHash
          || !crypto.timingSafeEqual(Buffer.from(s.credentialHash, 'hex'), Buffer.from(given, 'hex'))) {
          throw new Error('Unknown server or credential.');
        }
        return { server: s.id, install };
      }
      // enrol: the token is used once, inside its hour.
      const h = hash(frame.token);
      return store.withLock(enrolFile(h), async () => {
        const e = await store.readYaml(enrolFile(h));
        if (!e || e.usedAt || Date.parse(e.expiresAt) < now()) throw new Error('This enrolment token is unknown, used or expired. Make a new one with Add server.');
        const id = `srv_${crypto.randomBytes(6).toString('hex')}`;
        const credential = crypto.randomBytes(32).toString('base64url');
        const facts = frame.facts && typeof frame.facts === 'object' ? frame.facts : {};
        await store.writeYaml(serverFile(id), {
          id, site: e.site, hostname: String(facts.hostname ?? id).slice(0, 100), status: 'enrolling', credentialHash: hash(credential),
          facts, agentVersion: frame.agentVersion, enrolledAt: iso(), lastSeenAt: iso(), warnings: [],
        });
        await store.writeYaml(enrolFile(h), { ...e, usedAt: iso(), server: id });
        log.info(`server ${id} enrolled in site ${e.site}`);
        return { server: id, install, credential };
      });
    },

    /** R4: facts, allocatable and warnings from what the agent reports. */
    async recordFacts(id, facts) {
      const s = await store.readYaml(serverFile(id));
      if (!s) return null;
      const site = (await api.site(s.site)) ?? { reserve: DEFAULT_RESERVE };
      const warnings = [];
      if (facts.security && !facts.security.userns && !facts.security.rootless) warnings.push('Docker runs without user namespaces: a container escape would be root on this server.');
      if (facts.cgroup && facts.cgroup !== 2) warnings.push('cgroup v1: CPU and memory limits are less reliable.');
      const allocatable = {
        cpu: Math.max(0, Math.round(((facts.cpus ?? 0) - site.reserve.cpu) * 100) / 100),
        memoryMb: Math.max(0, (facts.memoryMb ?? 0) - site.reserve.memoryMb),
      };
      return api.update(id, { facts, hostname: String(facts.hostname ?? s.hostname).slice(0, 100), allocatable, warnings });
    },
  };
  return api;
}
