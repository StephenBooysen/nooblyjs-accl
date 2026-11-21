// Sites and servers for operators (spec 8.9 R1, R2, R4, R12, R13, HTTP): /api/v1/platform/local/*, behind the platform
// routes' change-guardrails check. Create a site; *Add server* makes a one-time enrolment token (shown once, valid for an
// hour) and the command that runs the agent with it; *Remove server* revokes its credential and closes its channel.
// Every write is audited by the API router. Customers never reach these routes: the launcher does not expose them.
import net from 'node:net';
import { handler } from '../util/http.js';
import { notFound, conflict, unprocessable } from '../util/errors.js';
import { DEFAULT_RESERVE } from '../platform/local.js';
import { AGENT_VERSION } from '../../agent/protocol.js';
import { controllerOf } from './agent-files.js';

const SITE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const SERVER_ID = /^srv_[a-z0-9]{8,32}$/;

/** Where a site's instances may listen: loopback, every address, or a private IPv4 address (LAN only in v1). */
function bindProblem(bind) {
  if (bind === '127.0.0.1' || bind === '0.0.0.0') return null;
  if (!net.isIPv4(bind)) return 'The bind address is an IPv4 address: 127.0.0.1 on one machine, 0.0.0.0 or a LAN address on a network.';
  const [a, b] = bind.split('.').map(Number);
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return lan ? null : 'LAN sites bind to a private address (10.x, 172.16–31.x or 192.168.x); public exposure comes later.';
}

/** Checks the *Create site* form. Returns { site } or { problems } keyed by field. */
export function checkSite(body = {}) {
  const problems = {};
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!SITE_ID.test(id)) problems.id = 'A site id is 2 to 31 lower-case letters, digits and hyphens, starting with a letter, such as lan-dev.';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : id;
  if (name.length > 60) problems.name = 'A site name is at most 60 characters.';
  const bind = typeof body.bind === 'string' && body.bind.trim() ? body.bind.trim() : '127.0.0.1';
  const bp = bindProblem(bind);
  if (bp) problems.bind = bp;
  const reserve = { ...DEFAULT_RESERVE };
  if (body.reserve !== undefined) {
    const cpu = Number(body.reserve?.cpu ?? DEFAULT_RESERVE.cpu);
    const memoryMb = Number(body.reserve?.memoryMb ?? DEFAULT_RESERVE.memoryMb);
    if (!Number.isFinite(cpu) || cpu < 0 || cpu > 16) problems['reserve.cpu'] = 'The CPU reserve is from 0 to 16 vCPU per server.';
    else reserve.cpu = Math.round(cpu * 100) / 100;
    if (!Number.isInteger(memoryMb) || memoryMb < 0 || memoryMb > 65_536) problems['reserve.memoryMb'] = 'The memory reserve is a whole number of MB from 0 to 65536 per server.';
    else reserve.memoryMb = memoryMb;
  }
  return Object.keys(problems).length ? { problems } : { site: { id, name, bind, reserve } };
}

const sum = (list, key) => Math.round(list.reduce((n, i) => n + (Number(i[key]) || 0), 0) * 100) / 100;

/**
 * @param {object} o
 * @param {object} o.host
 * @param {object} o.platform     createPlatform()'s result (addLocalSite, localRuntime)
 * @param {object} o.local        { servers: createLocalServers(), hub: createAgentHub() }
 * @param {string} o.mountPath
 */
export function localRoutes({ host, platform, local, mountPath }) {
  const r = host.express.Router();
  const { servers, hub } = local;

  /** One server row: its record, whether its agent is connected now, what it reserves and runs. */
  function serverRow(s, instances) {
    const mine = instances.filter((i) => i.server === s.id && i.status !== 'removed');
    const session = hub.session(s.id);
    const status = s.status === 'removed' ? 'removed' : session ? 'online' : s.status === 'enrolling' ? 'enrolling' : 'offline';
    return {
      id: s.id, site: s.site, hostname: s.hostname, status,
      agentVersion: session?.agentVersion ?? s.agentVersion ?? null,
      outdated: (session?.agentVersion ?? s.agentVersion) ? (session?.agentVersion ?? s.agentVersion) !== AGENT_VERSION : false,
      address: session?.address ?? null,
      facts: s.facts ?? {}, allocatable: s.allocatable ?? null, warnings: s.warnings ?? [],
      reserved: { cpu: sum(mine, 'cpu'), memoryMb: sum(mine, 'memoryMb') },
      // What its containers use now, from the agent's 10 s stats (8.9.9); null until the first sample.
      used: session ? platform.localRuntime?.serverStats(s.id) ?? null : null,
      instances: mine.map((i) => ({ name: i.name, tenant: i.labels?.['noobly-tenant'], workload: i.labels?.['noobly-workload'], status: i.status, url: i.url ?? null })),
      enrolledAt: s.enrolledAt ?? null, lastSeenAt: session?.lastSeenAt ?? s.lastSeenAt ?? null,
    };
  }

  async function siteView(site, instances) {
    const rows = (await servers.servers({ site: site.id })).map((s) => serverRow(s, instances));
    return { ...site, servers: rows, online: rows.filter((s) => s.status === 'online').length };
  }

  const instancesNow = async () => (platform.localRuntime ? platform.localRuntime.list() : []);

  r.get('/', handler(async (req, res) => {
    const instances = await instancesNow();
    // A host pool's site is shown with its pool (Host pools), not here.
    const sites = await Promise.all((await servers.sites()).filter((s) => s.mode !== 'pool').map((s) => siteView(s, instances)));
    res.json({ sites, agentVersion: AGENT_VERSION });
  }));

  r.post('/sites', handler(async (req, res) => {
    const { site, problems } = checkSite(req.body ?? {});
    if (problems) throw unprocessable('The site is not valid.', { fields: problems });
    let made;
    try {
      made = await servers.createSite({ ...site, by: req.person?.id ?? null });
    } catch (err) {
      if (err.code === 'exists') throw conflict(err.message, { fields: { id: err.message } });
      throw err;
    }
    platform.addLocalSite(made.id);
    res.status(201).json(await siteView(made, []));
  }));

  r.get('/sites/:site', handler(async (req, res) => {
    const site = await servers.site(req.params.site);
    if (!site) throw notFound(`No site ${req.params.site}.`);
    res.json(await siteView(site, await instancesNow()));
  }));

  // R2: Add server. The token is in this answer only; the store keeps its hash.
  r.post('/sites/:site/enrolments', handler(async (req, res) => {
    const site = await servers.site(req.params.site);
    if (!site) throw notFound(`No site ${req.params.site}.`);
    const { token, expiresAt } = await servers.createEnrolment(site.id, { by: req.person?.id ?? null });
    const controller = controllerOf(req, mountPath) ?? `${req.protocol}://<this host>${mountPath}`;
    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      site: site.id, token, expiresAt, controller,
      // Run on the new server (Ubuntu): installs the agent and its service, and enrols it with this token.
      command: `curl -fsSL ${controller}/agent/install.sh | sudo bash -s -- --token ${token}`,
      // Or, from a copy of the agent's folder with Node 22 (no systemd, no sudo).
      manual: `node agent/bin/noobly-agent.js run --controller ${controller} --token ${token}`,
    });
  }));

  r.get('/servers/:id', handler(async (req, res) => {
    const s = SERVER_ID.test(req.params.id) ? await servers.server(req.params.id) : null;
    if (!s || s.status === 'removed') throw notFound(`No server ${req.params.id}.`);
    res.json(serverRow(s, await instancesNow()));
  }));

  // R12: Remove server. Its credential stops working and its channel closes; it is refused if it dials again.
  r.delete('/servers/:id', handler(async (req, res) => {
    const s = SERVER_ID.test(req.params.id) ? await servers.server(req.params.id) : null;
    if (!s || s.status === 'removed') throw notFound(`No server ${req.params.id}.`);
    await servers.remove(s.id);
    hub.disconnect(s.id, 'This server was removed from its site.');
    res.json({ id: s.id, status: 'removed' });
  }));

  return r;
}
