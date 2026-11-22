// Postgres on a local site (spec 8.6, where the platform runs it: decision of 2026-11-22). The operator names one
// Postgres server for the site (`local.postgres.url`, an admin login such as the `postgres` superuser); each customer
// database is a database on it with a login role of the same name that owns it, a connection limit from its plan, and
// CONNECT taken from everyone else. Tenants reach it only through the agent's relay on their own network (agent/relay.js),
// which forwards a connection only for one of their databases as its own role.
//
// The admin URL is never logged or stored by this module; database passwords go to the secrets store.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import pg from 'pg';

/** The admin URL's parts, without the password (for logs, screens and the relay's target). */
export function serverOf(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('local.postgres.url is a postgres:// URL.');
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username || 'postgres'), database: decodeURIComponent(u.pathname.slice(1)) || 'postgres' };
}

/** A database's identifier on the server (also its role's): nb_<name>_<hash of tenant/name>, at most 56 characters. */
export function identifierOf(tenantId, name) {
  const hash = crypto.createHash('sha256').update(`${tenantId}/${name}`).digest('hex').slice(0, 12);
  return `nb_${String(name).replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${hash}`;
}

const IDENT = /^nb_[a-z0-9_]{1,40}_[0-9a-f]{12}$/;
const quote = (id) => {
  if (!IDENT.test(id)) throw new Error(`not a platform database: ${id}`);
  return `"${id}"`;
};

/**
 * @param {object} o
 * @param {string} o.url   the admin connection string
 * @param {string} [o.pgDump]
 * @param {string} [o.pgRestore]
 */
export function createLocalPostgres({ url, pgDump = 'pg_dump', pgRestore = 'pg_restore' }) {
  const server = serverOf(url);

  async function withClient(fn, database) {
    const u = new URL(url);
    if (database) u.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 5000, statement_timeout: 60_000 });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Runs pg_dump or pg_restore as the admin; the password goes in the environment, never the command line. */
  function tool(bin, args) {
    const u = new URL(url);
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGHOST: server.host, PGPORT: String(server.port), PGUSER: server.user, PGCONNECT_TIMEOUT: '10' };
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${bin} is not installed on the controller.`) : e));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `${bin} exited with ${code}`))));
    });
  }

  return {
    server,
    /** The server's version and whether the admin login works. → { version, ok } */
    async check() {
      return withClient(async (c) => ({ ok: true, version: (await c.query('SHOW server_version')).rows[0].server_version }));
    },

    /**
     * A new database and its login role (spec 8.6 R2): the role owns the database, may make at most `connections`
     * connections, and no one else may connect to it. → { database, user, password }
     */
    async create({ identifier, connections }) {
      const id = quote(identifier);
      const password = crypto.randomBytes(24).toString('base64url');
      await withClient(async (c) => {
        const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [identifier])).rowCount;
        if (exists) await c.query(`ALTER ROLE ${id} WITH LOGIN PASSWORD ${c.escapeLiteral(password)} CONNECTION LIMIT ${Number(connections)}`);
        else await c.query(`CREATE ROLE ${id} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${c.escapeLiteral(password)} CONNECTION LIMIT ${Number(connections)}`);
        if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [identifier])).rowCount) await c.query(`CREATE DATABASE ${id} OWNER ${id}`);
        await c.query(`REVOKE ALL ON DATABASE ${id} FROM PUBLIC`);
        await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${id} TO ${id}`);
      });
      return { database: identifier, user: identifier, password };
    },

    /** A new password for a database's role. → password */
    async resetPassword({ identifier }) {
      const password = crypto.randomBytes(24).toString('base64url');
      await withClient((c) => c.query(`ALTER ROLE ${quote(identifier)} WITH PASSWORD ${c.escapeLiteral(password)}`));
      return password;
    },

    async setConnections({ identifier, connections }) {
      await withClient((c) => c.query(`ALTER ROLE ${quote(identifier)} CONNECTION LIMIT ${Number(connections)}`));
    },

    /** Drops a database (its connections ended first) and its role. */
    async drop({ identifier }) {
      const id = quote(identifier);
      await withClient(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${id} WITH (FORCE)`);
        await c.query(`DROP ROLE IF EXISTS ${id}`);
      });
    },

    /** Size and connections of each database. → Map(identifier → { bytes, connections, limit }) */
    async stats(identifiers) {
      const ids = identifiers.filter((i) => IDENT.test(i));
      if (!ids.length) return new Map();
      return withClient(async (c) => {
        const { rows } = await c.query(`
          SELECT d.datname AS id, pg_database_size(d.datname) AS bytes,
                 (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections,
                 r.rolconnlimit AS limit
            FROM pg_database d LEFT JOIN pg_roles r ON r.rolname = d.datname
           WHERE d.datname = ANY($1)`, [ids]);
        return new Map(rows.map((r) => [r.id, { bytes: Number(r.bytes), connections: Number(r.connections), limit: Number(r.limit) }]));
      });
    },

    /** A custom-format dump of the database to `file` (spec 8.6 R3, local). → bytes */
    async backup({ identifier, file }) {
      quote(identifier);
      await tool(pgDump, ['--format=custom', '--no-owner', '--no-privileges', '--dbname', identifier, '--file', file]);
      return (await fs.stat(file)).size;
    },

    /** Loads a dump into a database (a new one, made with create()), its objects owned by that database's role. */
    async restore({ identifier, file }) {
      quote(identifier);
      await tool(pgRestore, ['--no-owner', '--no-privileges', '--role', identifier, '--dbname', identifier, '--exit-on-error', file]);
    },
  };
}
