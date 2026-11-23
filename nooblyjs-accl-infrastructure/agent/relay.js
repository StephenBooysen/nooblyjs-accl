// Relays (spec 8.6 R2, where the platform runs Postgres on a local site): a tenant's containers reach a database server
// on this machine (or the site's network) through a TCP relay the agent opens on the tenant network's gateway address
// (from RELAY_PORT up).
// Docker answers that address from every bridge network, so each connection's source must be inside that network's
// subnet: another tenant's container is refused before a byte is forwarded. The relay then reads the Postgres startup
// message and forwards it only when its database is one of the tenant's and its user is that database's own login role
// (the platform names the role after the database), so the server's other databases (`postgres`, the operator's own)
// cannot even be tried. TLS is declined ('N') so the startup can be read: the hop is inside this machine. The database
// checks the password as well.
//
// The agent relays only to the targets it was started with (`--relay-target host:port`), so a controller cannot use it
// to reach anything else on the server. Relays are written to the state folder and opened again when the agent starts.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

/** "172.20.0.0/16" → a test for an IPv4 address (or an IPv4-mapped IPv6 one). */
export function inSubnet(cidr) {
  const [base, bitsText] = String(cidr).split('/');
  const bits = Number(bitsText);
  const toInt = (ip) => {
    const parts = String(ip).replace(/^::ffff:/, '').split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  };
  const b = toInt(base);
  if (b === null || !Number.isInteger(bits) || bits < 8 || bits > 32) return () => false;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ip) => {
    const n = toInt(ip);
    return n !== null && ((n & mask) >>> 0) === ((b & mask) >>> 0);
  };
}

/**
 * Where relays listen on a tenant network's gateway: a range of their own, not the database's port, so a database
 * server that also listens on the gateway (bound to 0.0.0.0) is never what a tenant's container reaches there. The
 * egress firewall (firewall.js) opens only this range, only on the gateway.
 */
export const RELAY_PORT = 15432;
export const RELAY_PORT_SPAN = 20;

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
const PROTOCOL_3 = 196608;

/** A Postgres ErrorResponse (FATAL, 28000 invalid authorization) with `message`. */
export function pgError(message) {
  const fields = Buffer.concat([['S', 'FATAL'], ['V', 'FATAL'], ['C', '28000'], ['M', message]].map(([k, v]) => Buffer.concat([Buffer.from(k), Buffer.from(v, 'utf8'), Buffer.from([0])])).concat([Buffer.from([0])]));
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

/**
 * Reads the client's first messages: answers SSL and GSS requests with 'N', passes a cancel request on, and checks a
 * startup message. → { ok, buffer (what to forward), user, database, reason }; null while more bytes are needed.
 */
export function readStartup(buf) {
  let at = 0;
  const declined = [];
  while (buf.length - at >= 8) {
    const len = buf.readInt32BE(at);
    const code = buf.readInt32BE(at + 4);
    if (len === 8 && (code === SSL_REQUEST || code === GSS_REQUEST)) {
      declined.push('N');
      at += 8;
      continue;
    }
    if (len < 8 || len > 10_000) return { ok: false, reason: 'not a Postgres connection', declined };
    if (buf.length - at < len) return { pending: true, declined, consumed: at };
    if (code === CANCEL_REQUEST && len === 16) return { ok: true, cancel: true, buffer: buf.subarray(at), declined };
    if (code !== PROTOCOL_3) return { ok: false, reason: 'only protocol 3.0 is spoken here', declined };
    const params = {};
    const parts = buf.subarray(at + 8, at + len - 1).toString('utf8').split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) params[parts[i]] = parts[i + 1];
    return { ok: true, buffer: buf.subarray(at), user: params.user ?? '', database: params.database || params.user || '', declined };
  }
  return { pending: true, declined, consumed: at };
}

/**
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string[]} [o.targets]   "host:port" the agent may relay to
 * @param {(network: string) => Promise<{ gateway: string, subnet: string }|null>} o.inspect   a Docker network's address
 * @param {{ warn?: Function }} [o.log]
 */
export function createRelays({ stateDir, targets = [], inspect, log = {} }) {
  const allowed = new Set(targets);
  const open = new Map(); // network → { server, host, port, target, refused, connections }
  const file = path.join(stateDir, 'relays.json');

  const save = async () => {
    const list = [...open.entries()].map(([network, r]) => ({ network, target: r.target, port: r.port, databases: [...r.databases] }));
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(list, null, 2), { mode: 0o600 });
  };

  function listen(network, { gateway, subnet }, target, port, databases) {
    const [tHost, tPort] = [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))];
    const ok = inSubnet(subnet);
    const state = { host: gateway, port, target, subnet, refused: 0, connections: 0, databases: new Set(databases) };
    const server = net.createServer((client) => {
      if (!ok(client.remoteAddress)) {
        state.refused += 1;
        client.destroy();
        return;
      }
      let buf = Buffer.alloc(0);
      let answered = 0;
      const timer = setTimeout(() => client.destroy(), 10_000);
      const refuse = (message) => {
        state.refused += 1;
        clearTimeout(timer);
        client.end(pgError(message));
      };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const r = readStartup(buf);
        // Each SSL or GSS request is declined once.
        for (; answered < r.declined.length; answered += 1) client.write('N');
        if (r.pending) {
          if (buf.length > 10_000) refuse('The startup message is too long.');
          return;
        }
        client.off('data', onData);
        clearTimeout(timer);
        if (!r.ok) return refuse(r.reason);
        if (!r.cancel && !(state.databases.has(r.database) && r.user === r.database)) {
          return refuse(`Database "${r.database}" with user "${r.user}" is not one this network may reach. Use the connection string the platform gave.`);
        }
        state.connections += 1;
        const up = net.connect(tPort, tHost);
        up.write(r.buffer);
        client.pipe(up).pipe(client);
        const end = () => { client.destroy(); up.destroy(); };
        up.on('error', end);
        client.on('error', end);
        client.on('close', () => { state.connections -= 1; up.destroy(); });
      };
      client.on('data', onData);
      client.on('error', () => clearTimeout(timer));
    });
    state.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, gateway, () => {
        server.off('error', reject);
        server.on('error', (err) => log.warn?.(`relay for ${network}: ${err.message}`));
        resolve(state);
      });
    });
  }

  const api = {
    /**
     * Opens (or keeps) the relay for `network` to `target` ("host:port"), for these databases (each reached only as its
     * own login role, named after it). A relay that is open takes the new list at once. → { host, port, subnet }
     */
    async ensure({ network, target, port = RELAY_PORT, databases = [] }) {
      if (!allowed.has(target)) throw Object.assign(new Error(`This agent does not relay to ${target}. Start it with --relay-target ${target}.`), { code: 'refused' });
      const have = open.get(network);
      if (have && have.target === target) {
        have.databases = new Set(databases);
        await save();
        return { host: have.host, port: have.port, subnet: have.subnet };
      }
      if (have) await api.remove({ network });
      const addr = await inspect(network);
      if (!addr?.gateway || !addr?.subnet) throw new Error(`There is no network ${network} here.`);
      let state;
      // The port on the gateway: RELAY_PORT when free there, else the next ones (up to RELAY_PORT_SPAN more), the
      // range the egress firewall lets tenant containers reach on their gateway (firewall.js).
      for (let p = port, tries = 0; ; p += 1, tries += 1) {
        try {
          state = await listen(network, addr, target, p, databases);
          break;
        } catch (err) {
          if (err.code !== 'EADDRINUSE' || tries >= RELAY_PORT_SPAN) throw err;
        }
      }
      open.set(network, state);
      await save();
      return { host: state.host, port: state.port, subnet: state.subnet };
    },
    async remove({ network }) {
      const have = open.get(network);
      if (!have) return { removed: false };
      open.delete(network);
      await new Promise((r) => have.server.close(() => r()));
      await save();
      return { removed: true };
    },
    /** What is open: [{ network, host, port, target, connections, refused }]. */
    list: () => [...open.entries()].map(([network, r]) => ({ network, host: r.host, port: r.port, target: r.target, databases: [...r.databases], connections: r.connections, refused: r.refused })),
    /** Opens the relays written before a restart (those whose network and target still exist). */
    async restore() {
      let saved = [];
      try {
        saved = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch { /* none yet */ }
      for (const r of Array.isArray(saved) ? saved : []) {
        try {
          await api.ensure(r);
        } catch (err) {
          log.warn?.(`relay for ${r.network} not reopened: ${err.message}`);
        }
      }
      await save().catch(() => {});
    },
    async close() {
      for (const r of open.values()) r.server.close();
      open.clear();
    },
  };
  return api;
}
