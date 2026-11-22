// Spec 8.6 where the platform runs Postgres itself (decision of 2026-11-22), offline: the agent's relay refuses sources
// outside the tenant network's subnet, targets it was not started with, and any database or user that is not one of
// the tenant's own; a database is created, backed up (seven kept), restored into a new one, resized and deleted through
// operations; a linked variable becomes the connection string through the relay on the container's own network; and
// no other tenant can see, link or reach it. NOOBLY_REAL_POSTGRES=<admin URL> also runs it against a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './helpers.js';
import { createRelays, inSubnet, readStartup } from '../agent/relay.js';
import { checkCommand } from '../agent/protocol.js';
import { createMockPostgres } from '../src/platform/databases.js';
import { identifierOf } from '../src/platform/postgres-local.js';

const actor = { id: 'stevie', name: 'Stevie', kind: 'person' };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

/** A Postgres startup message for `user` and `database`. */
function startup(user, database) {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
  const b = Buffer.alloc(8);
  b.writeInt32BE(8 + params.length, 0);
  b.writeInt32BE(196608, 4);
  return Buffer.concat([b, params]);
}
const sslRequest = () => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(80877103, 4);
  return b;
};

/** Connects, sends `bytes`, and resolves with everything the relay sent back once it closes (or after `ms`). */
function talk(port, bytes, ms = 400) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const got = [];
    s.on('data', (d) => got.push(d));
    s.on('error', () => {});
    s.on('connect', () => { for (const b of [].concat(bytes)) s.write(b); });
    const done = () => resolve(Buffer.concat(got));
    s.on('close', done);
    setTimeout(() => { s.destroy(); done(); }, ms);
  });
}

test('8.6 relay: subnet, startup check, SSL declined, allow list; the commands are checked', async () => {
  assert.equal(inSubnet('172.20.0.0/16')('172.20.4.9'), true);
  assert.equal(inSubnet('172.20.0.0/16')('::ffff:172.20.4.9'), true);
  assert.equal(inSubnet('172.20.0.0/16')('172.21.0.1'), false);
  assert.equal(inSubnet('nonsense')('172.20.0.1'), false);
  assert.equal(readStartup(startup('nb_a_1', 'nb_a_1').subarray(0, 10)).pending, true);
  assert.deepEqual([readStartup(startup('u', 'd')).user, readStartup(startup('u', 'd')).database], ['u', 'd']);

  // A fake server that says what it was sent.
  const seen = [];
  const upstream = net.createServer((s) => s.on('data', (d) => { seen.push(d); s.write('OK'); }));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `127.0.0.1:${upstream.address().port}`;
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-'));
  const nets = { mine: { gateway: '127.0.0.1', subnet: '127.0.0.0/8' }, other: { gateway: '127.0.0.1', subnet: '10.9.0.0/16' } };
  const relays = createRelays({ stateDir, targets: [target], inspect: async (n) => nets[n] ?? null });
  try {
    await assert.rejects(relays.ensure({ network: 'mine', target: '127.0.0.1:1', databases: [] }), (e) => Boolean(e.code === 'refused' && /does not relay to/.test(e.message)));
    await assert.rejects(relays.ensure({ network: 'nope', target, databases: [] }), /no network nope/);
    const id = identifierOf('acme', 'main');
    const mine = await relays.ensure({ network: 'mine', target, port: 20000 + Math.floor(Math.random() * 20000), databases: [id] });

    // Its own database as its own role: SSL declined, the startup forwarded whole.
    const ok = await talk(mine.port, [sslRequest(), startup(id, id)]);
    assert.equal(ok.toString(), 'NOK');
    assert.deepEqual(Buffer.concat(seen), startup(id, id));

    // Another database, or its database as another user: refused with a Postgres error, nothing forwarded.
    seen.length = 0;
    for (const [u, d] of [['postgres', 'postgres'], [id, 'postgres'], ['postgres', id], [identifierOf('other', 'main'), identifierOf('other', 'main')]]) {
      const back = await talk(mine.port, startup(u, d));
      assert.equal(back[0], 'E'.charCodeAt(0), `${u}@${d} answered with an ErrorResponse`);
      assert.match(back.toString(), /is not one this network may reach/);
    }
    assert.equal(seen.length, 0, 'nothing reached the server');
    assert.equal((await talk(mine.port, Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toString().includes('not a Postgres connection'), true);

    // The list changes at once; a source outside the network's subnet is dropped before a byte is read.
    await relays.ensure({ network: 'mine', target, databases: [] });
    assert.match((await talk(mine.port, startup(id, id))).toString(), /is not one this network may reach/);
    await relays.remove({ network: 'mine' });
    const other = await relays.ensure({ network: 'other', target, port: mine.port, databases: [id] });
    assert.equal((await talk(other.port, startup(id, id))).length, 0, 'a connection from outside the subnet gets nothing');
    assert.equal(relays.list()[0].refused, 1);

    // Saved and opened again after a restart.
    const saved = JSON.parse(await fs.readFile(path.join(stateDir, 'relays.json'), 'utf8'));
    assert.deepEqual(saved, [{ network: 'other', target, port: other.port, databases: [id] }]);
  } finally {
    await relays.close();
    upstream.close();
  }

  assert.deepEqual(checkCommand('relay.ensure', { network: 'noobly-t-0123456789ab', target: '127.0.0.1:5432', databases: ['nb_main_0123456789ab'] }), []);
  assert.ok(checkCommand('relay.ensure', { network: 'noobly-t-0123456789ab', target: 'http://x', databases: [] }).length);
  assert.ok(checkCommand('relay.ensure', { network: 'host', target: '127.0.0.1:5432' }).length);
});

async function start() {
  const engine = createMockPostgres();
  const app = await startApp({
    platform: { enabled: true },
    local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock', drainMs: 50, postgres: { engine } },
    agents: { checkMs: 0 },
  });
  await app.hosted.local.agent.welcome;
  assert.ok(await until(async () => (await app.hosted.local.servers.servers())[0]?.status === 'online'));
  return { app, engine, platform: app.hosted.services.platform, docker: app.hosted.local.agent.docker };
}

test('8.6 databases: create, connection, stats, plan, backups (seven kept), restore, delete; other tenants see nothing', async () => {
  const { app, platform } = await start();
  const dbs = platform.databases;
  try {
    await assert.rejects(dbs.create('acme', { name: 'Main', region: 'mars-1', plan: { connections: 2 } }), (e) => Boolean(e.status === 422 && e.details.fields.name && e.details.fields.region && e.details.fields['plan.connections']));
    const { database, operation } = await dbs.create('acme', { name: 'main', region: 'lan-dev', plan: { connections: 20, storageMb: 1024 } }, { actor });
    assert.equal(database.status, 'creating');
    assert.equal(database.passwordRef, undefined, 'the record shown has no password');
    assert.ok(operation.id);
    await assert.rejects(dbs.create('acme', { name: 'main', region: 'lan-dev' }), (e) => e.status === 409);
    await app.hosted.idle();
    const got = await dbs.get('acme', 'main');
    assert.equal(got.status, 'available');
    assert.equal(got.identifier, identifierOf('acme', 'main'));
    assert.equal(got.user, got.identifier);
    assert.equal(got.backupTime, '03:00');

    const conn = await dbs.connection('acme', 'main');
    assert.match(conn.url, new RegExp(`^postgres://${got.user}:[A-Za-z0-9_-]{32}@postgres\\.mock:5432/${got.database}\\?sslmode=disable$`));
    const stats = await dbs.stats('acme', 'main');
    assert.equal(stats.limitConnections, 20);
    assert.equal(stats.limitBytes, 1024 * 1_000_000);
    assert.ok(stats.bytes > 0);

    // Another tenant: not found, the same as a database that does not exist.
    for (const call of [() => dbs.get('other', 'main'), () => dbs.connection('other', 'main'), () => dbs.backup('other', 'main'), () => dbs.remove('other', 'main')]) {
      await assert.rejects(call(), (e) => e.status === 404);
    }
    assert.deepEqual(await dbs.list('other'), []);

    // Backups: on demand, seven kept, the oldest file removed with its record.
    for (let i = 0; i < 8; i += 1) {
      await dbs.backup('acme', 'main', { actor });
      await app.hosted.idle();
    }
    const backups = await dbs.backups('acme', 'main');
    assert.equal(backups.length, 7);
    const dir = path.join(app.dataDir, 'platform-databases', 'acme', 'main', 'backups');
    assert.equal((await fs.readdir(dir)).length, 7);

    // Restore: a new database from a backup; the source is untouched.
    await assert.rejects(dbs.restore('acme', 'main', 'bak_nope', { into: 'copy' }), (e) => e.status === 404);
    const r = await dbs.restore('acme', 'main', backups[3].id, { into: 'copy', actor });
    assert.equal(r.database.restoredFrom.backupId, backups[3].id);
    await app.hosted.idle();
    assert.equal((await dbs.get('acme', 'copy')).status, 'available');
    assert.notEqual((await dbs.connection('acme', 'copy')).password, conn.password);

    // Plan and daily backup time.
    assert.equal((await dbs.update('acme', 'main', { plan: { connections: 40 }, backupTime: null }, { actor })).plan.connections, 40);
    await assert.rejects(dbs.update('acme', 'main', { backupTime: '25:00' }), (e) => e.status === 422);

    // Delete: dropped, its backups and password gone.
    await dbs.remove('acme', 'copy', { actor });
    await dbs.remove('acme', 'main', { actor });
    await app.hosted.idle();
    assert.deepEqual(await dbs.list('acme'), []);
    await assert.rejects(fs.readdir(dir), /ENOENT/);
    const events = app.eventLog.map((e) => e.type);
    for (const t of ['infrastructure.database.status', 'infrastructure.database.backed_up', 'infrastructure.database.deleted']) assert.ok(events.includes(t), t);
  } finally {
    await app.close();
  }
});

test('8.6 links: DATABASE_URL through the relay on the tenant network; jobs too; other tenants cannot link or reach it', async () => {
  const { app, platform, docker } = await start();
  const service = (over = {}) => ({
    name: 'api', kind: 'service', region: 'lan-dev', source: { repo: 'https://github.com/render-examples/express-hello-world', branch: 'main' },
    build: { runtime: 'node22', startCommand: 'npm start' }, run: { port: 10400, env: [{ key: 'DATABASE_URL', link: { database: 'main' } }] },
    plan: { cpu: 0.5, memoryMb: 512 }, instances: 1, healthCheck: { path: '/' }, ...over,
  });
  try {
    await assert.rejects(platform.workloads.create('acme', service(), { actor }), (e) => Boolean(e.status === 422 && /no database main/.test(e.details.fields['run.env.0'])));
    await platform.databases.create('acme', { name: 'main', region: 'lan-dev' }, { actor });
    await platform.databases.create('acme', { name: 'cloudy', region: 'europe-west2' }, { actor });
    await platform.databases.create('rival', { name: 'main', region: 'lan-dev' }, { actor });
    await app.hosted.idle();
    await assert.rejects(platform.workloads.create('acme', service({ name: 'far', run: { port: 10400, env: [{ key: 'DATABASE_URL', link: { database: 'cloudy' } }] } }), { actor }), (e) => Boolean(e.status === 422 && /europe-west2/.test(e.details.fields['run.env.0'])));

    await platform.workloads.create('acme', service(), { actor });
    await app.hosted.idle();
    assert.equal((await platform.workloads.get('acme', 'api')).status, 'live');
    const c = docker.state.containers.find((x) => x.labels['noobly-workload'] === 'api');
    const url = c.args.env.find((e) => e.key === 'DATABASE_URL').value;
    const relay = docker.relays.find((x) => x.network === c.args.network);
    assert.ok(relay, 'a relay on the container\'s own network');
    assert.equal(relay.target, 'postgres.mock:5432');
    const mine = await platform.databases.get('acme', 'main');
    assert.deepEqual(relay.databases, [mine.identifier], 'the relay reaches the tenant\'s databases only');
    assert.equal(url, (await platform.databases.connection('acme', 'main')).url.replace('postgres.mock:5432', `${relay.host}:${relay.port}`));
    assert.ok(!relay.databases.includes((await platform.databases.get('rival', 'main')).identifier));

    // A job's run joins the same network and gets the same link.
    await platform.workloads.create('acme', service({ name: 'migrate', kind: 'job', run: { command: 'npm run migrate', env: [{ key: 'DATABASE_URL', link: { database: 'main' } }] }, healthCheck: undefined }), { actor });
    await app.hosted.idle();
    await platform.workloads.runJob('acme', 'migrate', { actor });
    await app.hosted.idle();
    const run = docker.jobs.at(-1);
    assert.equal(run.env.find((e) => e.key === 'DATABASE_URL').value, url);

    // A second database is added to the relay's list at once; deleting both closes it.
    await platform.databases.create('acme', { name: 'second', region: 'lan-dev' }, { actor });
    await app.hosted.idle();
    assert.equal(docker.relays.find((x) => x.network === c.args.network).databases.length, 2);
    await platform.databases.remove('acme', 'second', { actor });
    await platform.databases.remove('acme', 'main', { actor });
    await app.hosted.idle();
    assert.equal(docker.relays.find((x) => x.network === c.args.network), undefined);
  } finally {
    await app.close();
  }
});

test('8.6 a site without a Postgres server says so', async () => {
  const app = await startApp({ platform: { enabled: true }, local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock' }, agents: { checkMs: 0 } });
  try {
    await assert.rejects(app.hosted.services.platform.databases.create('acme', { name: 'main', region: 'lan-dev' }), /no Postgres server/);
    // The mock cloud has one.
    await app.hosted.services.platform.databases.create('acme', { name: 'main', region: 'europe-west2' }, { actor });
    await app.hosted.idle();
    assert.equal((await app.hosted.services.platform.databases.get('acme', 'main')).status, 'available');
  } finally {
    await app.close();
  }
});

const REAL = process.env.NOOBLY_REAL_POSTGRES;
test('8.6 real Postgres: a database only its own role reaches, through a relay; backup and restore; dropped', { skip: !REAL && 'set NOOBLY_REAL_POSTGRES to an admin URL' }, async () => {
  const { createLocalPostgres } = await import('../src/platform/postgres-local.js');
  const { default: pg } = await import('pg');
  const engine = createLocalPostgres({ url: REAL });
  const id = identifierOf(`test-${process.pid}`, 'main');
  const id2 = identifierOf(`test-${process.pid}`, 'copy');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-'));
  const target = `${engine.server.host}:${engine.server.port}`;
  const relays = createRelays({ stateDir, targets: [target], inspect: async () => ({ gateway: '127.0.0.1', subnet: '127.0.0.0/8' }) });
  try {
    const creds = await engine.create({ identifier: id, connections: 5 });
    const relay = await relays.ensure({ network: 'n', target, port: 25432, databases: [id] });
    const client = (o) => new pg.Client({ host: '127.0.0.1', port: relay.port, user: creds.user, password: creds.password, database: creds.database, ...o });
    const c = client();
    await c.connect();
    await c.query('CREATE TABLE notes (body text)');
    await c.query("INSERT INTO notes VALUES ('hello')");
    await c.end();
    await assert.rejects(async () => { const x = client({ database: 'postgres' }); await x.connect(); }, /not one this network may reach/);
    await assert.rejects(async () => { const x = client({ user: 'postgres' }); await x.connect(); }, /not one this network may reach/);
    await assert.rejects(async () => { const x = client({ password: 'wrong' }); await x.connect(); }, /password authentication failed/);
    const s = (await engine.stats([id])).get(id);
    assert.equal(s.limit, 5);
    const file = path.join(stateDir, 'main.dump');
    assert.ok(await engine.backup({ identifier: id, file }) > 0);
    const c2 = await engine.create({ identifier: id2, connections: 5 });
    await engine.restore({ identifier: id2, file });
    const k = new pg.Client({ host: engine.server.host, port: engine.server.port, user: c2.user, password: c2.password, database: c2.database });
    await k.connect();
    assert.equal((await k.query('SELECT body FROM notes')).rows[0].body, 'hello');
    await k.end();
    // The copy's role cannot connect to the first database even straight to the server.
    await assert.rejects(async () => { const x = new pg.Client({ host: engine.server.host, port: engine.server.port, user: c2.user, password: c2.password, database: id }); await x.connect(); }, /permission denied/);
  } finally {
    await relays.close();
    await engine.drop({ identifier: id }).catch(() => {});
    await engine.drop({ identifier: id2 }).catch(() => {});
  }
});

test('8.7 Key Value (local): a Valkey container on the tenant network, private name, password, link, resize, delete', async () => {
  const { app, platform, docker } = await start();
  const kv = platform.keyvalue;
  try {
    await assert.rejects(kv.create('acme', { name: 'cache', region: 'lan-dev', plan: { eviction: 'random', memoryMb: 8 } }), (e) => Boolean(e.status === 422 && e.details.fields['plan.eviction'] && e.details.fields['plan.memoryMb']));
    await kv.create('acme', { name: 'cache', region: 'lan-dev', plan: { memoryMb: 128 } }, { actor });
    await app.hosted.idle();
    const got = await kv.get('acme', 'cache');
    assert.equal(got.status, 'available', got.reason);
    assert.equal(got.host, 'cache-kv.acme.internal');
    const c = docker.state.containers.find((x) => x.name === got.host && false) ?? docker.state.containers.find((x) => /-kv-cache$/.test(x.name));
    assert.ok(c, 'a container for the store');
    assert.deepEqual(c.args.aliases, ['cache-kv.acme.internal']);
    assert.match(c.args.network, /^noobly-t-/);
    assert.equal(c.args.hostPort, undefined, 'no port on the host');
    assert.match(c.args.command.join(' '), /--maxmemory 128mb --maxmemory-policy allkeys-lru --maxclients 100 --save ''/);
    const { url, password } = await kv.connection('acme', 'cache');
    assert.ok(!c.args.command.join(' ').includes(password), 'the password is not on the command line');
    assert.equal(c.args.env.find((e) => e.key === 'KV_PASSWORD').value, password);
    assert.equal(url, `redis://default:${password}@cache-kv.acme.internal:6379`);
    await assert.rejects(kv.get('rival', 'cache'), (e) => e.status === 404);
    await assert.rejects(kv.connection('rival', 'cache'), (e) => e.status === 404);

    // Linked: REDIS_URL in the container's environment; a rival's workload cannot link it.
    const service = (tenant, over = {}) => ({
      name: 'api', kind: 'service', region: 'lan-dev', source: { repo: 'https://github.com/render-examples/express-hello-world', branch: 'main' },
      build: { runtime: 'node22', startCommand: 'npm start' }, run: { port: 10400, env: [{ key: 'REDIS_URL', link: { keyvalue: 'cache' } }] },
      plan: { cpu: 0.5, memoryMb: 512 }, instances: 1, healthCheck: { path: '/' }, ...over,
    });
    await assert.rejects(platform.workloads.create('rival', service('rival'), { actor }), (e) => Boolean(e.status === 422 && /no Key Value store cache/.test(e.details.fields['run.env.0'])));
    await platform.workloads.create('acme', service('acme'), { actor });
    await app.hosted.idle();
    const api = docker.state.containers.find((x) => x.labels['noobly-workload'] === 'api');
    assert.equal(api.args.env.find((e) => e.key === 'REDIS_URL').value, url);
    assert.equal(api.args.network, c.args.network, 'the service and the store share the tenant network');

    // Resize: started again with the new limit, the same password; the agent coming back leaves it alone.
    const { operation } = await kv.update('acme', 'cache', { plan: { memoryMb: 256, eviction: 'noeviction' } }, { actor });
    assert.ok(operation);
    await app.hosted.idle();
    const c2 = docker.state.containers.find((x) => /-kv-cache$/.test(x.name));
    assert.match(c2.args.command.join(' '), /--maxmemory 256mb --maxmemory-policy noeviction/);
    assert.equal((await kv.connection('acme', 'cache')).password, password);
    assert.equal((await kv.stats('acme', 'cache')).memoryMb, 256);

    await kv.remove('acme', 'cache', { actor });
    await app.hosted.idle();
    assert.equal(docker.state.containers.find((x) => /-kv-cache$/.test(x.name)), undefined);
    assert.deepEqual(await kv.list('acme'), []);
  } finally {
    await app.close();
  }
});
