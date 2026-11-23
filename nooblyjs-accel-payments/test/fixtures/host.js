// The stand-in host: an Express app (5, or 4 under `npm run test:express4`), a shared EventEmitter, and a stand-in
// nooblyjs-core serviceRegistry whose dataService keeps containers in memory (and lets a test read everything stored,
// for the "no card data" check). Roles come from the X-Roles header.
import { EventEmitter } from 'node:events';
import { mount, createTestClock } from '../../index.js';

export const EXPRESS_MAJOR = process.env.EXPRESS_MAJOR === '4' ? 4 : 5;
export const express = (await import(EXPRESS_MAJOR === 4 ? 'express4' : 'express')).default;

export function memoryDataService() {
  const containers = new Map();
  const need = (name) => {
    if (!containers.has(name)) throw new Error(`Container '${name}' does not exist.`);
    return containers.get(name);
  };
  return {
    containers,
    async createContainer(name) {
      if (containers.has(name)) throw new Error(`Container '${name}' already exists.`);
      containers.set(name, new Map());
    },
    async addWithKey(name, key, doc) { need(name).set(key, structuredClone(doc)); return key; },
    async update(name, key, doc) { need(name).set(key, structuredClone(doc)); return true; },
    async remove(name, key) { return need(name).delete(key); },
    async getByUuid(name, key) { return structuredClone(need(name).get(key) ?? null); },
    async listAll(name) { return [...need(name).values()].map((d) => structuredClone(d)); },
    /** Everything stored, as text. */
    dump: () => JSON.stringify([...containers].map(([k, v]) => [k, [...v.values()]])),
  };
}

export function testRegistry() {
  const data = memoryDataService();
  const lines = [];
  const logger = Object.fromEntries(['error', 'warn', 'info', 'log', 'debug'].map((l) => [l, (m) => { lines.push(`${l}: ${m}`); }]));
  const published = [];
  return {
    initialized: true, data, lines, published,
    dataService: () => data,
    logger: () => logger,
    notifying: () => ({ publish: (topic, event) => published.push({ topic, event }) }),
  };
}

/**
 * Mounts the accelerator on a fresh app and listens on a free port.
 * @param {object} [o]   mount options (merged), plus { start: ISO time for the test clock }
 */
export async function startHost(o = {}) {
  const app = express();
  const eventEmitter = new EventEmitter();
  const registry = testRegistry();
  const clock = createTestClock(o.start ?? '2026-03-01T00:00:00.000Z');
  const emails = [];
  const seen = [];
  eventEmitter.on('pay.*', (e) => seen.push(e));
  const pay = await mount(app, eventEmitter, registry, {
    express,
    clock,
    jobs: { enabled: false },
    auth: { roleResolver: (req) => (req.get('x-roles') ?? '').split(',').filter(Boolean) },
    notify: async (kind, data) => { emails.push({ kind, to: data.account.email, invoice: data.invoice?.number ?? null, data: data.data }); },
    brand: 'Test Cloud',
    publicUrl: 'http://cloud.test',
    tax: { rates: [{ country: 'ZA', rate: 1500, inclusive: false, name: 'VAT' }] },
    seller: { name: 'Test Cloud Ltd', taxId: '4123456789', address: { line1: '1 Main Road', city: 'Cape Town', country: 'ZA' } },
    ...o,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { body, roles = 'admin', headers = {}, raw = false } = {}) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(roles ? { 'x-roles': roles } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  }
  return {
    app, url, pay, clock, registry, emails, seen, eventEmitter,
    get: (p, opt) => call('GET', p, opt), post: (p, opt) => call('POST', p, opt), patch: (p, opt) => call('PATCH', p, opt), del: (p, opt) => call('DELETE', p, opt),
    async close() {
      await pay.shutdown();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Saves a test card for an account through the mock provider's hosted fields, as CardForm does. */
export async function saveCard(t, accountId, number = '4242424242424242', exp = '12/30') {
  const setup = await t.pay.payments.setupMethod(accountId);
  const secret = new URL(setup.fieldsUrl).searchParams.get('secret');
  const res = await t.post('/admin/payments/p/mock/setups', { roles: '', body: { secret, number, exp, cvc: '123' } });
  if (res.status !== 200) throw Object.assign(new Error(res.json?.error?.message ?? 'card refused'), { status: res.status, json: res.json });
  return t.pay.payments.confirmMethod(accountId, setup.setupId);
}

/** The usual catalogue: a monthly price billed by the hour ($5 a month per service), and a seat price. */
export async function catalogue(t) {
  return t.pay.billing.ensureCatalogue({
    meters: [{ key: 'standard_hours', name: 'Standard service hours', unit: 'hour' }],
    products: [{ key: 'standard', name: 'Standard instance', unitLabel: 'service-hour' }, { key: 'seat', name: 'Seat', unitLabel: 'seat' }],
    prices: [
      { key: 'standard-hourly', product: 'standard', type: 'metered', meter: 'standard_hours', unitAmount: 500, divideBy: 'month_hours' },
      { key: 'seat-monthly', product: 'seat', type: 'per_unit', unitAmount: 1000 },
    ],
  });
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
