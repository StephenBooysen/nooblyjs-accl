// mount() (roadmap 0.2, 0.6): checked before anything is mounted, on Express 4 and 5; health and OpenAPI; roles
// refused and audited; the operator screens and components served; no card data in records, events, logs or output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mount, normaliseOptions, TEST_CARDS } from '../index.js';
import { express, EXPRESS_MAJOR, testRegistry, startHost, saveCard, catalogue } from './fixtures/host.js';

const hosts = [];
after(async () => { for (const h of hosts) await h.close(); });

test(`a bad option mounts nothing (Express ${EXPRESS_MAJOR})`, async () => {
  for (const [opts, re] of [
    [{ modules: ['billing'] }, /requires 'payments'/],
    [{ modules: ['nope'] }, /unknown module/],
    [{ basePath: 'admin/' }, /basePath/],
    [{ currency: 'usd' }, /currency/],
    [{ provider: { type: 'stripe' } }, /Stripe provider needs/],
    [{ provider: { name: 'half', customers: {} } }, /lacks/],
    [{ dunning: { retryDays: [3, 1] } }, /retryDays/],
    [{ tax: { rates: [{ country: 'ZA', rate: 15.5, name: 'VAT' }] } }, /tax.rates/],
  ]) {
    const app = express();
    let uses = 0;
    const use = app.use.bind(app);
    app.use = (...args) => { uses += 1; return use(...args); };
    await assert.rejects(mount(app, new EventEmitter(), testRegistry(), { express, ...opts }), re, JSON.stringify(opts));
    assert.equal(uses, 0, 'nothing mounted');
  }
  await assert.rejects(mount(express(), new EventEmitter(), { ...testRegistry(), initialized: false }, { express }), /initialise/);
  assert.throws(() => normaliseOptions({}, { NODE_ENV: 'production' }), /mock provider is refused in production/);
  assert.throws(() => normaliseOptions({ allowMockInProduction: true }, { NODE_ENV: 'production' }), /signingSecret/);
});

test('health, OpenAPI, screens and components; roles refused and audited; shutdown is idempotent', async () => {
  const t = await startHost();
  hosts.push(t);
  assert.equal((await t.get('/admin/payments/api/v1/health', { roles: '' })).json.provider, 'mock');
  assert.equal((await t.get('/admin/billing/api/v1/health', { roles: '' })).json.status, 'ok');
  const spec = await t.get('/admin/billing/api/v1/openapi.json', { roles: '' });
  assert.ok(spec.json.paths['/invoices/{id}:finalize']);
  const ui = await t.get('/admin/payments/', { roles: '' });
  assert.equal(ui.status, 200);
  assert.match(ui.text, /<main class="pay-main"/);
  assert.doesNotMatch(ui.text, /<script>|style="|onclick=/);
  assert.equal((await t.get('/admin/payments/components/card-form.js', { roles: '' })).status, 200);
  assert.equal((await t.get('/admin/payments/api/v1/accounts', { roles: '' })).status, 403);
  assert.equal((await t.post('/admin/billing/api/v1/prices', { roles: 'support', body: {} })).status, 403);
  assert.equal((await t.post('/admin/billing/api/v1/meters', { roles: 'finance', body: { key: 'cpu_hours', name: 'CPU hours', unit: 'hour' } })).status, 201);
  assert.ok(t.pay.audit.list().some((a) => a.outcome === 'refused'));
  const created = await t.post('/admin/payments/api/v1/accounts', { roles: 'service', body: { name: 'Api Co', email: 'pay@api.test', externalRef: 'ws-api' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('etag'), 'W/"2"');
  const stale = await t.patch(`/admin/payments/api/v1/accounts/${created.json.id}`, { roles: 'finance', headers: { 'if-match': 'W/"1"' }, body: { name: 'Renamed' } });
  assert.equal(stale.status, 412);
  const found = await t.get('/admin/payments/api/v1/accounts:lookup?externalRef=ws-api', { roles: 'readonly' });
  assert.equal(found.json.id, created.json.id);
  const bad = await t.post('/admin/payments/api/v1/accounts', { roles: 'admin', body: '{not json', headers: { 'content-type': 'application/json' } });
  assert.deepEqual([bad.status, bad.json.error.code], [400, 'invalid_json']);
  await t.pay.shutdown();
  await t.pay.shutdown();
});

test('no card data in records, events, logs, emails or responses', async () => {
  const t = await startHost();
  hosts.push(t);
  await catalogue(t);
  const out = [];
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-pci', name: 'PCI Co', email: 'pay@pci.test' });
  for (const number of Object.keys(TEST_CARDS)) {
    try { await saveCard(t, a.id, number); } catch (err) { out.push(JSON.stringify(err.json ?? err.message)); }
  }
  await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Check', amount: 100 }] });
  await t.pay.idle();
  out.push(JSON.stringify((await t.get(`/admin/payments/api/v1/accounts/${a.id}/methods`)).json));
  out.push(JSON.stringify((await t.get(`/admin/billing/api/v1/accounts/${a.id}/summary`)).json));
  const everything = [t.registry.data.dump(), JSON.stringify(t.seen), JSON.stringify(t.emails), t.registry.lines.join('\n'), JSON.stringify(t.registry.published), ...out].join('\n');
  for (const number of Object.keys(TEST_CARDS)) assert.ok(!everything.includes(number), `card ${number.slice(-4)} leaked`);
  assert.doesNotMatch(everything, /\b(?:\d[ -]?){13,19}\b/, 'nothing card-like');
  assert.match(everything, /"last4":"4242"/, 'display data is kept');
});
