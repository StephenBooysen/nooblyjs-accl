// The launcher contract (architecture.md §3): the accelerator mounts once under its path, never listens, signs people
// in with the launcher, refuses with an audit record, writes only inside its own folder, and a bad start mounts
// nothing. Every test runs on Express 5 and again on Express 4 (npm test runs both).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp, filesUnder, FALLBACK } from './helpers.js';
import { EXPRESS_MAJOR } from './fixtures/host.js';
import { enabledProviders } from '../index.js';

const API = '/infrastructure/api/v1';

test(`mount() mounts the API under the mount path and describes itself (Express ${EXPRESS_MAJOR})`, async () => {
  const t = await startApp();
  try {
    assert.equal(t.mountError, null);
    const about = await t.get(`${API}/about`, { as: 'naledi-k' });
    assert.equal(about.status, 200);
    assert.deepEqual({ name: about.json.name, mountPath: about.json.mountPath, providers: about.json.providers }, { name: 'infrastructure', mountPath: '/infrastructure', providers: ['mock'] });
    assert.match(about.json.version, /^\d+\.\d+\.\d+$/);
    for (const key of ['name', 'label', 'title', 'icon', 'mountPath', 'ui', 'nav', 'status', 'services', 'seed', 'shutdown', 'close', 'idle']) assert.ok(t.hosted[key], key);
  } finally {
    await t.close();
  }
});

test('the accelerator works under another mount path, and leaves everything else to the launcher', async () => {
  const t = await startApp({ mountPath: '/cloud' });
  try {
    assert.equal((await t.get('/cloud/api/v1/about', { as: 'stevie' })).json.mountPath, '/cloud');
    assert.equal((await t.get('/infrastructure/api/v1/about', { as: 'stevie' })).text, FALLBACK);
    assert.equal((await t.get('/somewhere-else', { as: 'stevie' })).text, FALLBACK);
  } finally {
    await t.close();
  }
});

test('the API is signed-in only, and unknown routes and bad bodies use the one error shape', async () => {
  const t = await startApp();
  try {
    const signedOut = await t.get(`${API}/summary`);
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.json.error.code, 'unauthenticated');
    const missing = await t.get(`${API}/nope`, { as: 'stevie' });
    assert.equal(missing.status, 404);
    assert.deepEqual(Object.keys(missing.json.error).sort(), ['code', 'message']);
    const badJson = await t.post(`${API}/seed`, { as: 'stevie', body: '{not json', headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'bad_request');
  } finally {
    await t.close();
  }
});

test('a role without the permission gets 403 and the refusal is audited; every write is audited', async () => {
  const t = await startApp();
  try {
    const refused = await t.post(`${API}/seed`, { as: 'priya-s', body: { reset: true } });
    assert.equal(refused.status, 403);
    assert.ok(t.auditLog.some((a) => a.action === 'access.refused' && a.actor === 'priya-s' && a.permission === 'change-guardrails'));
    const before = t.auditLog.length;
    assert.equal((await t.post(`${API}/seed`, { as: 'stevie', body: { reset: true } })).status, 201);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(t.auditLog.slice(before).some((a) => a.actor === 'stevie' && a.action === `POST ${API}/seed` && a.status === 201));
  } finally {
    await t.close();
  }
});

test('an error inside an async route reaches the error handler, in the error shape, on Express 4 and 5', async () => {
  // Only seed.yaml is broken, so the accelerator starts, and the seed route is what fails.
  const broken = (host) => {
    const readYaml = host.store.readYaml.bind(host.store);
    host.store.readYaml = async (segments) => {
      if (segments.join('/') === 'seed.yaml') throw new Error('disk on fire');
      return readYaml(segments);
    };
    return host;
  };
  const t = await startApp({ changeHost: broken });
  try {
    const res = await t.post(`${API}/seed`, { as: 'stevie', body: {} });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'internal_error');
    assert.doesNotMatch(res.text, /disk on fire/, 'a server fault never leaks its message');
    assert.ok(t.serviceRegistry.lines.some((l) => l.level === 'error' && /disk on fire/.test(l.message)), 'and it is logged');
  } finally {
    await t.close();
  }
});

test('everything is written inside the accelerator\'s own folder', async () => {
  const t = await startApp({ seed: true });
  try {
    await t.post(`${API}/seed`, { as: 'stevie', body: { reset: true } });
    const all = await filesUnder(t.rootDir);
    assert.ok(all.includes('infrastructure/seed.yaml'));
    assert.deepEqual(all.filter((f) => !f.startsWith('infrastructure/')), []);
  } finally {
    await t.close();
  }
});

test('a bad start throws before anything is mounted', async () => {
  for (const [why, options] of [
    ['no EventEmitter', { eventEmitter: null }],
    ['an EventEmitter that cannot emit', { eventEmitter: {} }],
    ['a host without events', { changeHost: (h) => ({ ...h, events: undefined }) }],
    ['a host without a frame', { changeHost: (h) => ({ ...h, frame: undefined }) }],
    ['a serviceRegistry nobody initialised', { serviceRegistry: { initialized: false } }],
    ['a mount path that is not a path', { mountPath: 'infrastructure' }],
  ]) {
    const t = await startApp(options).catch((err) => ({ mountError: err, close: async () => {} }));
    try {
      assert.ok(t.mountError, why);
      if (t.get) assert.equal((await t.get(`${API}/about`, { as: 'stevie' })).text, FALLBACK, why);
    } finally {
      await t.close();
    }
  }
});

test('every event goes to the launcher\'s EventEmitter as well as host.events, and a failing listener breaks nothing', async () => {
  const t = await startApp();
  try {
    const seen = [];
    t.eventEmitter.on('infrastructure.account.connected', (payload) => seen.push(payload));
    t.eventEmitter.on('infrastructure.operation.queued', () => { throw new Error('listener on fire'); });
    const res = await t.post(`${API}/accounts`, { as: 'stevie', body: { cloud: 'gcp', name: 'stevie-dev', projectId: 'stevie-dev-1', defaultRegion: 'europe-west2', credentials: JSON.stringify({ type: 'service_account', project_id: 'stevie-dev', private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n' }) } });
    assert.equal(res.status, 202);
    await t.hosted.idle();
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].system, seen[0].name], ['infrastructure', 'stevie-dev']);
    assert.ok(t.eventLog.some((e) => e.type === 'infrastructure.account.connected'), 'host.events still gets it');
    assert.equal((await t.get(`${API}/accounts/stevie-dev`, { as: 'stevie' })).json.state, 'connected');
    assert.ok(t.serviceRegistry.lines.some((l) => l.level === 'warn' && /listener on fire/.test(l.message)), 'the failure is logged');
  } finally {
    await t.close();
  }
});

test('shutdown() is idempotent and close() is the same function', async () => {
  const t = await startApp();
  try {
    assert.equal(t.hosted.close, t.hosted.shutdown);
    await Promise.all([t.hosted.shutdown(), t.hosted.shutdown()]);
    await t.hosted.shutdown();
  } finally {
    await t.close();
  }
});

test('INFRA_PROVIDERS names the clouds this install may use, and an unknown one stops the start', async () => {
  assert.deepEqual(enabledProviders(undefined), ['mock']);
  assert.deepEqual(enabledProviders(' mock, gcp,aws,gcp '), ['mock', 'gcp', 'aws']);
  assert.throws(() => enabledProviders('mock,azure'), /not azure/);
  const saved = process.env.INFRA_PROVIDERS;
  process.env.INFRA_PROVIDERS = 'azure';
  try {
    const t = await startApp();
    try {
      assert.match(t.mountError?.message ?? '', /INFRA_PROVIDERS/);
      assert.equal((await t.get(`${API}/about`, { as: 'stevie' })).text, FALLBACK);
    } finally {
      await t.close();
    }
  } finally {
    if (saved === undefined) delete process.env.INFRA_PROVIDERS;
    else process.env.INFRA_PROVIDERS = saved;
  }
});

test('the accelerator never initialises the serviceRegistry, and uses the launcher\'s logging and queueing', async () => {
  const t = await startApp();
  try {
    assert.deepEqual(t.serviceRegistry.calls.map((c) => `${c.service}:${c.instanceName}`).sort(), ['logging:infrastructure', 'queueing:infrastructure']);
  } finally {
    await t.close();
  }
});

test('seeding is idempotent, and a reset empties the folder and writes the story again', async () => {
  const t = await startApp();
  try {
    const marker = path.join(t.dataDir, 'seed.yaml');
    const notes = path.join(t.dataDir, 'notes.md');
    await t.hosted.seed({ reset: false });
    const first = await fs.readFile(marker, 'utf8');
    assert.match(first, /story: noobly-cloud/);
    await fs.writeFile(notes, 'written by hand\n');
    await t.hosted.seed({ reset: false });
    assert.equal(await fs.readFile(marker, 'utf8'), first, 'an already seeded folder is left alone');
    assert.equal(await fs.readFile(notes, 'utf8'), 'written by hand\n');
    await t.hosted.seed({ reset: true });
    await assert.rejects(fs.readFile(notes, 'utf8'), { code: 'ENOENT' });
    assert.match(await fs.readFile(marker, 'utf8'), /story: noobly-cloud/);
  } finally {
    await t.close();
  }
});

test('every seeded install has its own install id, kept by a reset (two installs on one Docker never share a label)', async () => {
  const [a, b] = [await startApp({ seed: true }), await startApp({ seed: true })];
  try {
    const idOf = async (t) => /installId: (\S+)/.exec(await fs.readFile(path.join(t.dataDir, 'config.yaml'), 'utf8'))?.[1];
    const [ida, idb] = [await idOf(a), await idOf(b)];
    assert.match(ida, /^nc-[0-9a-f]{8}$/);
    assert.notEqual(ida, idb, 'two folders, two ids');
    // The story's labels carry the install's own id, not a fixed one.
    const cloud = await fs.readFile(path.join(a.dataDir, 'mock-cloud', 'stevie-prod.yaml'), 'utf8');
    assert.ok(cloud.includes(`noobly-install: ${ida}`));
    assert.ok(!/\{\{install\}\}|nc-seed01/.test(cloud));
    await a.hosted.seed({ reset: true });
    assert.equal(await idOf(a), ida, 'a reset keeps the id');
    // A folder seeded before ids were per install still says nc-seed01: a reset gives it its own.
    await fs.writeFile(path.join(b.dataDir, 'config.yaml'), 'installId: nc-seed01\n');
    await b.hosted.seed({ reset: true });
    assert.match(await idOf(b), /^nc-[0-9a-f]{8}$/);
  } finally {
    await a.close();
    await b.close();
  }
});
