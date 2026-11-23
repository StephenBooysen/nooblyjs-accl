// The billing module (spec §2 billing/, §6): the catalogue (meters, products, prices), subscriptions, usage, invoices
// (draft → finalise with a gapless number → collect), tax lines, account credit, credit notes and the period close.
// Licensed items (flat, per unit) are billed in advance, metered usage in arrears; mid-period changes of licensed items
// add proration lines to the next invoice.
import { conflict, invalid, notFound, checker } from '../shared/errors.js';
import { newId } from '../shared/ids.js';
import { money, mulDiv, basisPoints, isCurrency } from '../shared/money.js';
import { assertCan, SYSTEM } from '../shared/runtime.js';
import { createMutex } from '../shared/store.js';
import { rateItem, DAY } from './rating.js';
import { nextBoundary, periodFrom, prorationLines, prorate } from './proration.js';

const KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const PRICE_TYPES = ['flat', 'per_unit', 'metered', 'tiered', 'one_off'];
const str = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;
const int = (v, min = 0) => Number.isSafeInteger(v) && v >= min;

export function createBillingService(S) {
  const { repos, usage, ledger, events, audit, clock, options } = S;
  const pay = () => S.paymentsService;
  const now = () => clock.now();
  const iso = (ms = now()) => new Date(ms).toISOString();
  const subLock = createMutex();
  const numberLock = createMutex();

  // ---- catalogue ------------------------------------------------------------------------------------------------

  async function createMeter(input, ctx = SYSTEM) {
    assertCan(ctx, 'catalogue.write');
    const c = checker();
    if (!KEY.test(input.key ?? '')) c.fail('key', 'Lower-case letters, digits, _ . -; starting with a letter; up to 64.');
    if (!str(input.name, 120)) c.fail('name', 'Up to 120 characters.');
    if (!str(input.unit, 40)) c.fail('unit', 'What one unit is, such as hour or GB.');
    if (input.aggregate !== undefined && !['sum', 'max', 'last'].includes(input.aggregate)) c.fail('aggregate', 'sum, max or last.');
    c.throwIfAny();
    const meter = await repos.meters.insert({ id: newId('mtr'), key: input.key, name: input.name.trim(), unit: input.unit.trim(), aggregate: input.aggregate ?? 'sum' });
    await audit.record({ ctx, action: 'meter.created', ref: { type: 'meter', id: meter.id } });
    return meter;
  }

  async function createProduct(input, ctx = SYSTEM) {
    assertCan(ctx, 'catalogue.write');
    const c = checker();
    if (input.key !== undefined && input.key !== null && !KEY.test(input.key)) c.fail('key', 'Lower-case letters, digits, _ . -; up to 64.');
    if (!str(input.name, 120)) c.fail('name', 'Up to 120 characters.');
    if (input.description !== undefined && input.description !== null && (typeof input.description !== 'string' || input.description.length > 500)) c.fail('description', 'Up to 500 characters.');
    if (input.unitLabel !== undefined && input.unitLabel !== null && !str(input.unitLabel, 40)) c.fail('unitLabel', 'Up to 40 characters.');
    c.throwIfAny();
    const product = await repos.products.insert({ id: newId('prod'), key: input.key ?? null, name: input.name.trim(), description: input.description ?? null, unitLabel: input.unitLabel ?? null, active: true, metadata: input.metadata ?? {} });
    await audit.record({ ctx, action: 'product.created', ref: { type: 'product', id: product.id } });
    return product;
  }

  async function updateProduct(id, patch, ctx = SYSTEM) {
    assertCan(ctx, 'catalogue.write');
    const fields = {};
    if (patch.name !== undefined) { if (!str(patch.name, 120)) throw invalid('The name is up to 120 characters.', [{ path: 'name', message: 'Required.' }]); fields.name = patch.name.trim(); }
    if (patch.description !== undefined) fields.description = patch.description;
    if (patch.active !== undefined) fields.active = Boolean(patch.active);
    const p = await repos.products.update(id, (x) => ({ ...x, ...fields }), { what: 'The product' });
    await audit.record({ ctx, action: 'product.updated', ref: { type: 'product', id }, details: { fields: Object.keys(fields) } });
    return p;
  }

  const meterByKey = (key) => repos.meters.list((m) => m.key === key)[0] ?? null;

  function checkPrice(input) {
    const c = checker();
    if (input.key !== undefined && input.key !== null && !KEY.test(input.key)) c.fail('key', 'Lower-case letters, digits, _ . -; up to 64.');
    if (!repos.products.get(input.productId ?? '')) c.fail('productId', 'A product of this catalogue.');
    if (!PRICE_TYPES.includes(input.type)) c.fail('type', `One of ${PRICE_TYPES.join(', ')}.`);
    if (!isCurrency(input.currency ?? options.currency)) c.fail('currency', 'An ISO 4217 code.');
    if (input.type !== 'one_off' && input.interval !== undefined && !['month', 'year'].includes(input.interval)) c.fail('interval', 'month or year.');
    const tiers = input.tiers;
    if (tiers !== undefined && tiers !== null) {
      if (!Array.isArray(tiers) || !tiers.length || tiers.length > 20) c.fail('tiers', '1 to 20 tiers.');
      else tiers.forEach((t, i) => {
        const last = i === tiers.length - 1;
        if (!int(t.unitAmount)) c.fail(`tiers.${i}.unitAmount`, 'Minor units, 0 or more.');
        if (t.flatAmount !== undefined && !int(t.flatAmount)) c.fail(`tiers.${i}.flatAmount`, 'Minor units, 0 or more.');
        if (last ? t.upTo !== null && t.upTo !== undefined : !int(t.upTo, 1) || (i > 0 && t.upTo <= tiers[i - 1].upTo)) c.fail(`tiers.${i}.upTo`, last ? 'The last tier has no limit (null).' : 'Ascending whole numbers.');
      });
    } else if (!int(input.unitAmount)) c.fail('unitAmount', 'Minor units (cents), 0 or more.');
    if (input.type === 'tiered' && !tiers?.length) c.fail('tiers', 'A tiered price has tiers.');
    if (input.type === 'metered' || (input.type === 'tiered' && input.meter)) {
      if (!meterByKey(input.meter ?? '')) c.fail('meter', 'The key of a meter of this catalogue.');
    }
    if (input.freeAllowance !== undefined && !int(input.freeAllowance)) c.fail('freeAllowance', 'Units, 0 or more.');
    if (input.divideBy !== undefined && input.divideBy !== null && input.divideBy !== 'month_hours' && !int(input.divideBy, 1)) c.fail('divideBy', 'A whole number, or month_hours.');
    c.throwIfAny();
  }

  async function createPrice(input, ctx = SYSTEM) {
    assertCan(ctx, 'catalogue.write');
    checkPrice(input);
    const meter = input.meter ? meterByKey(input.meter) : null;
    const price = await repos.prices.insert({
      id: newId('price'), key: input.key ?? null, productId: input.productId, type: input.type,
      currency: input.currency ?? options.currency, interval: input.type === 'one_off' ? null : (input.interval ?? 'month'),
      unitAmount: input.tiers?.length ? null : input.unitAmount, tiers: input.tiers ?? null,
      meterId: meter?.id ?? null, aggregate: input.aggregate ?? meter?.aggregate ?? 'sum',
      freeAllowance: input.freeAllowance ?? 0, divideBy: input.divideBy ?? null,
      nickname: input.nickname ?? null, active: true, metadata: input.metadata ?? {},
    });
    await audit.record({ ctx, action: 'price.created', ref: { type: 'price', id: price.id }, details: { productId: price.productId, unitAmount: price.unitAmount } });
    events.emit('pay.price.created', { priceId: price.id, productId: price.productId, key: price.key });
    return price;
  }

  const priceInUse = (id) => repos.subscriptions.count((s) => s.items.some((i) => i.priceId === id)) > 0 || repos.invoices.count((i) => i.lines.some((l) => l.priceId === id)) > 0;

  async function updatePrice(id, patch, ctx = SYSTEM) {
    assertCan(ctx, 'catalogue.write');
    const current = repos.prices.must(id, 'The price');
    const money_ = ['unitAmount', 'tiers', 'freeAllowance', 'divideBy', 'type', 'currency', 'interval', 'meter'].filter((k) => patch[k] !== undefined);
    if (money_.length && priceInUse(id)) throw conflict('This price is in use and cannot change: create a new price and make the old one inactive.');
    if (money_.length) checkPrice({ ...current, meter: repos.meters.get(current.meterId)?.key, ...patch });
    const fields = {};
    for (const k of ['unitAmount', 'tiers', 'freeAllowance', 'divideBy', 'nickname']) if (patch[k] !== undefined) fields[k] = patch[k];
    if (patch.active !== undefined) fields.active = Boolean(patch.active);
    const p = await repos.prices.update(id, (x) => ({ ...x, ...fields }), { what: 'The price' });
    await audit.record({ ctx, action: 'price.updated', ref: { type: 'price', id }, details: { fields: Object.keys(fields) } });
    return p;
  }

  /** Creates the meters, products and prices that are missing, by key; never changes one that exists (O3). */
  async function ensureCatalogue({ meters = [], products = [], prices = [] }, ctx = SYSTEM) {
    const out = { meters: {}, products: {}, prices: {} };
    for (const m of meters) out.meters[m.key] = meterByKey(m.key) ?? await createMeter(m, ctx);
    for (const p of products) out.products[p.key] = repos.products.list((x) => x.key === p.key)[0] ?? await createProduct(p, ctx);
    for (const p of prices) {
      const productId = p.productId ?? out.products[p.product]?.id ?? repos.products.list((x) => x.key === p.product)[0]?.id;
      out.prices[p.key] = repos.prices.list((x) => x.key === p.key)[0] ?? await createPrice({ ...p, productId }, ctx);
    }
    return out;
  }

  /** The newest active price of a product (by id or key). */
  function currentPrice(product, { currency = options.currency } = {}) {
    const prod = repos.products.get(product) ?? repos.products.list((x) => x.key === product)[0];
    if (!prod) return null;
    return repos.prices.list((p) => p.productId === prod.id && p.active && p.currency === currency)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))[0] ?? null;
  }

  // ---- usage ----------------------------------------------------------------------------------------------------

  /** Records usage: one event or up to 1,000 in a batch, idempotent by key. */
  async function recordUsage(input, ctx = SYSTEM) {
    assertCan(ctx, 'usage.write');
    const list = Array.isArray(input) ? input : [input];
    if (!list.length || list.length > 1000) throw invalid('Send 1 to 1,000 usage events at a time.');
    const c = checker();
    const checked = list.map((ev, i) => {
      const p = list.length > 1 ? `${i}.` : '';
      const account = repos.accounts.get(ev?.accountId ?? '');
      if (!account) c.fail(`${p}accountId`, 'An account of this accelerator.');
      if (!meterByKey(ev?.meter ?? '')) c.fail(`${p}meter`, 'The key of a meter.');
      if (!int(ev?.quantity)) c.fail(`${p}quantity`, 'A whole number of the meter\'s unit, 0 or more.');
      const at = ev?.at ? Date.parse(ev.at) : now();
      if (!Number.isFinite(at) || at > now() + DAY) c.fail(`${p}at`, 'An ISO time, not in the future.');
      if (typeof ev?.idempotencyKey !== 'string' || ev.idempotencyKey.length < 1 || ev.idempotencyKey.length > 255) c.fail(`${p}idempotencyKey`, 'A key of up to 255 characters, the same for a retry of the same event.');
      return { accountId: ev?.accountId, meter: ev?.meter, quantity: ev?.quantity, at: Number.isFinite(at) ? new Date(at).toISOString() : null, idempotencyKey: ev?.idempotencyKey };
    });
    c.throwIfAny();
    return usage.record(checked);
  }

  /** Totals per meter for an account over [from, to). */
  async function usageFor(accountId, { from, to }) {
    const evs = await usage.query(accountId, Date.parse(from), Date.parse(to));
    const out = {};
    for (const ev of evs) out[ev.meter] = (out[ev.meter] ?? 0) + ev.quantity;
    return out;
  }

  // ---- subscriptions --------------------------------------------------------------------------------------------

  const cycleOf = (sub) => ({ interval: sub.interval, anchor: sub.anchor, anchorDay: sub.anchorDay });

  function checkItems(items, account) {
    const c = checker();
    if (!Array.isArray(items) || !items.length || items.length > 50) c.fail('items', '1 to 50 items, each { priceId, quantity }.');
    const prices = [];
    (Array.isArray(items) ? items : []).forEach((it, i) => {
      const price = repos.prices.get(it?.priceId ?? '');
      if (!price || !price.active || price.type === 'one_off') c.fail(`items.${i}.priceId`, 'An active recurring price.');
      else if (price.currency !== account.currency) c.fail(`items.${i}.priceId`, `Priced in ${price.currency}; the account pays in ${account.currency}.`);
      if (it?.quantity !== undefined && !int(it.quantity, 1)) c.fail(`items.${i}.quantity`, 'A whole number, 1 or more.');
      if (price) prices.push(price);
    });
    if (new Set(prices.map((p) => p.interval)).size > 1) c.fail('items', 'Every item of a subscription has the same interval.');
    if (new Set((items ?? []).map((i) => i?.priceId)).size !== (items ?? []).length) c.fail('items', 'A price appears once.');
    c.throwIfAny();
    return prices;
  }

  const lineFor = (price, quantity, period) => rateItem({ price, product: repos.products.get(price.productId), quantity, period });
  const isMetered = (price) => Boolean(price.meterId);

  /** Where the billing cycle that holds `startMs` began (a calendar month or year start; anchored: the period start). */
  const cycleStartOf = (startMs, sub) => (sub.anchor === 'calendar'
    ? (sub.interval === 'year' ? Date.UTC(new Date(startMs).getUTCFullYear(), 0, 1) : Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1))
    : startMs);
  /** The whole cycle of the current period (a first, partial period counts against its full month). */
  const cycleOfPeriod = (sub) => ({ start: new Date(cycleStartOf(Date.parse(sub.currentPeriod.start), sub)).toISOString(), end: sub.currentPeriod.end });

  /** A licensed item's line for a period: the full amount for a whole cycle, else prorated by day. */
  function licensedLine(price, quantity, period, sub) {
    const line = lineFor(price, quantity, period);
    const start = Date.parse(period.start);
    const cycleStart = cycleStartOf(start, sub);
    if (cycleStart === start) return line;
    const amount = prorate(line.amount.amount, { at: period.start, periodStart: new Date(cycleStart).toISOString(), periodEnd: period.end });
    return { ...line, description: `${line.description} (from ${period.start.slice(0, 10)})`, amount: money(amount, line.amount.currency) };
  }

  async function subscribe(input, ctx = SYSTEM) {
    assertCan(ctx, 'subscriptions.write');
    const account = pay().getAccount(input.accountId ?? '');
    const prices = checkItems(input.items, account);
    const c = checker();
    if (input.trialDays !== undefined && !(int(input.trialDays) && input.trialDays <= 730)) c.fail('trialDays', '0 to 730 days.');
    if (input.anchor !== undefined && !['calendar', 'creation'].includes(input.anchor)) c.fail('anchor', 'calendar (the 1st of each month) or creation.');
    const startMs = input.startAt ? Date.parse(input.startAt) : now();
    if (!Number.isFinite(startMs) || startMs > now()) c.fail('startAt', 'An ISO time, not in the future.');
    if (repos.subscriptions.count((s) => s.accountId === account.id && s.status !== 'cancelled' && s.externalKey && s.externalKey === input.externalKey)) c.fail('externalKey', 'The account has a subscription with this key.');
    c.throwIfAny();
    const interval = prices[0].interval;
    const anchor = input.anchor ?? 'calendar';
    const d = new Date(startMs);
    const cycle = { interval, anchor, anchorDay: d.getUTCDate() };
    const trialEnd = input.trialDays ? startMs + input.trialDays * DAY : null;
    const sub = await repos.subscriptions.insert({
      id: newId('sub'), accountId: account.id, externalKey: input.externalKey ?? null,
      items: input.items.map((it) => ({ priceId: it.priceId, quantity: it.quantity ?? 1 })),
      interval, anchor, anchorDay: cycle.anchorDay,
      status: trialEnd ? 'trialing' : 'active', trialEnd: trialEnd ? iso(trialEnd) : null,
      currentPeriod: trialEnd ? { start: iso(startMs), end: iso(trialEnd) } : periodFrom(startMs, cycle),
      cancelAtPeriodEnd: false, pausedAt: null, endedAt: null, metadata: input.metadata ?? {},
      startedAt: iso(startMs),
    });
    await audit.record({ ctx, action: 'subscription.created', ref: { type: 'subscription', id: sub.id }, details: { items: sub.items } });
    events.emit('pay.subscription.created', { subscriptionId: sub.id, accountId: account.id, items: sub.items, status: sub.status });
    // Licensed items are paid in advance: the first period now (prorated to the next boundary).
    if (!trialEnd) {
      const lines = sub.items.map((it) => ({ it, price: repos.prices.get(it.priceId) })).filter(({ price }) => !isMetered(price))
        .map(({ it, price }) => licensedLine(price, it.quantity, sub.currentPeriod, sub)).filter((l) => l.amount.amount !== 0);
      if (lines.length) await issueInvoice({ account, sub, period: sub.currentPeriod, lines, at: iso(startMs), reason: 'subscription_create' });
    }
    return repos.subscriptions.get(sub.id);
  }

  /**
   * Replaces a subscription's items. Licensed changes are prorated by day: on the next invoice ('next', the default),
   * on an invoice now ('now'), or not at all ('none'). Metered items rate the whole period at the price on the item when
   * the period closes.
   */
  async function updateItems(subId, { items, prorate: mode = 'next' }, ctx = SYSTEM) {
    assertCan(ctx, 'subscriptions.write');
    return subLock(subId, async () => {
      const sub = repos.subscriptions.must(subId, 'The subscription');
      if (sub.status === 'cancelled') throw conflict('The subscription is cancelled.');
      const account = pay().getAccount(sub.accountId);
      const prices = checkItems(items, account);
      if (prices[0].interval !== sub.interval) throw invalid(`The subscription bills every ${sub.interval}.`, [{ path: 'items', message: 'Same interval.' }]);
      if (!['next', 'now', 'none'].includes(mode)) throw invalid('prorate is next, now or none.', [{ path: 'prorate', message: 'next, now or none.' }]);
      const next = items.map((it) => ({ priceId: it.priceId, quantity: it.quantity ?? 1 }));
      const licensed = (list) => list.map((it) => ({ it, price: repos.prices.get(it.priceId) })).filter(({ price }) => !isMetered(price))
        .map(({ it, price }) => {
          const line = lineFor(price, it.quantity, sub.currentPeriod);
          return { amount: line.amount.amount, description: line.description, priceId: price.id, quantity: it.quantity };
        });
      const before = licensed(sub.items);
      const after = licensed(next);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      if (changed && mode !== 'none' && sub.status !== 'trialing') {
        const lines = prorationLines({ old: before, next: after, at: iso(), period: cycleOfPeriod(sub), currency: account.currency });
        if (mode === 'now' && lines.length) await issueInvoice({ account, sub, period: sub.currentPeriod, lines, at: iso(), reason: 'subscription_update' });
        else for (const line of lines) await repos.pending.insert({ id: newId('ii'), accountId: account.id, subscriptionId: sub.id, line, invoiceId: null });
      }
      const updated = await repos.subscriptions.update(subId, (s) => ({ ...s, items: next }));
      await audit.record({ ctx, action: 'subscription.changed', ref: { type: 'subscription', id: subId }, details: { items: next, prorate: mode } });
      events.emit('pay.subscription.changed', { subscriptionId: subId, accountId: sub.accountId, items: next });
      return updated;
    });
  }

  async function cancel(subId, { atPeriodEnd = true, reason = 'requested' } = {}, ctx = SYSTEM) {
    assertCan(ctx, 'subscriptions.write');
    if (!atPeriodEnd) return cancelNow(subId, { reason, ctx });
    const sub = await repos.subscriptions.update(subId, (s) => (s.status === 'cancelled' ? null : { ...s, cancelAtPeriodEnd: true, cancelReason: reason }), { what: 'The subscription' });
    await audit.record({ ctx, action: 'subscription.cancel_scheduled', ref: { type: 'subscription', id: subId }, details: { reason } });
    return sub;
  }

  /** Ends a subscription now: a final invoice for the usage so far, and a credit for unused licensed time. */
  async function cancelNow(subId, { reason = 'requested', ctx = SYSTEM } = {}) {
    return subLock(subId, async () => {
      const sub = repos.subscriptions.must(subId, 'The subscription');
      if (sub.status === 'cancelled') return sub;
      const account = pay().getAccount(sub.accountId);
      const period = { start: sub.currentPeriod.start, end: iso() };
      const lines = await usageLines(sub, period);
      const licensed = sub.items.map((it) => ({ it, price: repos.prices.get(it.priceId) })).filter(({ price }) => !isMetered(price))
        .map(({ it, price }) => {
          const line = lineFor(price, it.quantity, sub.currentPeriod);
          return { amount: line.amount.amount, description: line.description, priceId: price.id, quantity: it.quantity };
        });
      if (sub.status !== 'trialing') lines.push(...prorationLines({ old: licensed, next: [], at: iso(), period: cycleOfPeriod(sub), currency: account.currency }));
      lines.push(...await takePending(sub));
      if (lines.length) await issueInvoice({ account, sub, period, lines, at: iso(), reason: 'subscription_cancel' });
      const updated = await repos.subscriptions.update(subId, (s) => ({ ...s, status: 'cancelled', endedAt: iso(), cancelReason: reason, currentPeriod: period }));
      await audit.record({ ctx, action: 'subscription.cancelled', ref: { type: 'subscription', id: subId }, details: { reason } });
      events.emit('pay.subscription.cancelled', { subscriptionId: subId, accountId: sub.accountId, reason });
      return updated;
    });
  }

  async function pause(subId, ctx = SYSTEM) {
    assertCan(ctx, 'subscriptions.write');
    const sub = await repos.subscriptions.update(subId, (s) => (s.status === 'cancelled' || s.pausedAt ? null : { ...s, pausedAt: iso() }), { what: 'The subscription' });
    await audit.record({ ctx, action: 'subscription.paused', ref: { type: 'subscription', id: subId } });
    return sub;
  }

  /** Resumes collection: invoices drafted while paused are finalised and collected. */
  async function resume(subId, ctx = SYSTEM) {
    assertCan(ctx, 'subscriptions.write');
    const sub = await repos.subscriptions.update(subId, (s) => (s.pausedAt ? { ...s, pausedAt: null } : null), { what: 'The subscription' });
    await audit.record({ ctx, action: 'subscription.resumed', ref: { type: 'subscription', id: subId } });
    for (const inv of repos.invoices.list((i) => i.subscriptionId === subId && i.status === 'draft' && i.paused)) {
      await repos.invoices.update(inv.id, (i) => ({ ...i, paused: false }));
      await finalize(inv.id, SYSTEM);
    }
    return sub;
  }

  // ---- invoices -------------------------------------------------------------------------------------------------

  function taxRateFor(account) {
    if (account.taxExempt || !account.country) return null;
    return options.tax.rates.find((r) => r.country === account.country) ?? null;
  }

  /** Subtotal, tax lines and total for lines, for an account (spec §6: rounding at the tax line, half-even). */
  function totalsFor(lines, account) {
    const currency = account.currency;
    const subtotal = lines.reduce((s, l) => s + l.amount.amount, 0);
    const rate = taxRateFor(account);
    let tax = 0;
    let net = subtotal;
    if (rate) {
      if (rate.inclusive) {
        tax = subtotal - mulDiv(subtotal, 10_000, 10_000 + rate.rate);
        net = subtotal - tax;
      } else {
        tax = basisPoints(subtotal, rate.rate);
      }
    }
    const total = rate?.inclusive ? subtotal : subtotal + tax;
    return {
      subtotal: money(subtotal, currency), net: money(net, currency), tax: money(tax, currency), total: money(total, currency),
      taxLines: rate ? [{ name: rate.name, country: rate.country, rate: rate.rate, inclusive: Boolean(rate.inclusive), amount: money(tax, currency), taxable: money(subtotal, currency) }] : [],
    };
  }

  async function nextNumber(prefix, currency, year) {
    return numberLock(`${prefix}:${currency}:${year}`, async () => {
      const id = `ctr_${prefix}_${currency}_${year}`;
      const doc = repos.counters.get(id);
      const value = (doc?.value ?? 0) + 1;
      if (doc) await repos.counters.update(id, (d) => ({ ...d, value }));
      else await repos.counters.insert({ id, value });
      const series = currency === options.currency ? `${prefix}-${year}` : `${prefix}-${currency}-${year}`;
      return `${series}-${String(value).padStart(6, '0')}`;
    });
  }

  function sellerSnapshot() {
    return options.seller ? { ...options.seller } : null;
  }

  /** A draft invoice saved for an account (lines already rated). */
  async function draft({ account, sub = null, period = null, lines, at = iso(), reason = 'manual', memo = null }) {
    const totals = totalsFor(lines, account);
    return repos.invoices.insert({
      id: newId('in'), number: null, accountId: account.id, subscriptionId: sub?.id ?? null, status: 'draft', reason,
      currency: account.currency, period, lines, ...totals,
      creditApplied: money(0, account.currency), amountDue: money(0, account.currency), amountPaid: money(0, account.currency),
      amountRemaining: money(0, account.currency), credited: money(0, account.currency),
      billingDetails: { name: account.name, email: account.email, country: account.country, taxId: account.taxId, address: account.address },
      seller: sellerSnapshot(), memo,
      issuedAt: at, finalizedAt: null, dueAt: null, paidAt: null, attempts: 0, nextAttemptAt: null, paused: Boolean(sub?.pausedAt),
    });
  }

  /** Finalises a draft: a gapless number, the account's credit applied, ledger postings, then collection. */
  async function finalize(invoiceId, ctx = SYSTEM, { collect = true } = {}) {
    assertCan(ctx, 'invoices.write');
    const inv = repos.invoices.must(invoiceId, 'The invoice');
    if (inv.status !== 'draft') throw conflict(`Invoice ${inv.number ?? inv.id} is ${inv.status}.`);
    if (inv.paused) throw conflict('Collection is paused for this subscription: resume it to finalise.');
    const account = pay().getAccount(inv.accountId);
    // Rates may have changed since the draft (an address added): work the totals out again.
    const totals = totalsFor(inv.lines, account);
    const total = totals.total.amount;
    const credit = account.creditBalance.amount;
    const applied = Math.min(credit, Math.max(total, 0));
    const due = Math.max(total, 0) - applied;
    const createdCredit = total < 0 ? -total : 0;
    const at = inv.issuedAt && Date.parse(inv.issuedAt) < now() ? inv.issuedAt : iso();
    const number = await nextNumber('INV', inv.currency, new Date(at).getUTCFullYear());
    const lines = [['receivable', total], ['revenue', -totals.net.amount], ['tax_payable', -totals.tax.amount]];
    if (applied) lines.push(['customer_credit', applied], ['receivable', -applied]);
    if (createdCredit) lines.push(['receivable', createdCredit], ['customer_credit', -createdCredit]);
    await ledger.post({ accountId: account.id, currency: inv.currency, ref: { type: 'invoice', id: inv.id }, memo: `Invoice ${number}`, lines, at });
    if (applied || createdCredit) await repos.accounts.update(account.id, (a) => ({ ...a, creditBalance: money(a.creditBalance.amount - applied + createdCredit, a.currency) }));
    const finalized = await repos.invoices.update(invoiceId, (i) => ({
      ...i, ...totals, number, status: 'open', finalizedAt: at, dueAt: at,
      creditApplied: money(applied, i.currency), amountDue: money(due, i.currency), amountRemaining: money(due, i.currency),
      billingDetails: { name: account.name, email: account.email, country: account.country, taxId: account.taxId, address: account.address },
    }));
    await audit.record({ ctx, action: 'invoice.finalized', ref: { type: 'invoice', id: invoiceId }, details: { number, total: totals.total, amountDue: finalized.amountDue } });
    events.emit('pay.invoice.finalized', { invoiceId, accountId: account.id, number, total: totals.total, amountDue: finalized.amountDue, subscriptionId: inv.subscriptionId });
    if (due === 0) return pay().markPaid(invoiceId);
    // Charged now with the card on file, or (collect: false) emailed as a payment link to the hosted checkout.
    await S.notifier.send(collect ? 'invoice.ready' : 'invoice.payment_link', { account, invoice: finalized, url: pay().invoiceUrl(invoiceId), idempotencyKey: `pay:ready:${invoiceId}` });
    if (collect) await pay().collect(invoiceId, { automatic: true });
    return repos.invoices.get(invoiceId);
  }

  async function issueInvoice({ account, sub, period, lines, at, reason }) {
    const inv = await draft({ account, sub, period, lines, at, reason });
    if (inv.paused) return inv;
    return finalize(inv.id, SYSTEM);
  }

  async function usageLines(sub, period, { upTo } = {}) {
    if (sub.status === 'trialing') return [];
    const end = Math.min(Date.parse(period.end), upTo ?? Infinity);
    const lines = [];
    for (const it of sub.items) {
      const price = repos.prices.get(it.priceId);
      if (!isMetered(price)) continue;
      const meter = repos.meters.get(price.meterId);
      const evs = await usage.query(sub.accountId, Date.parse(period.start), end, meter.key);
      const line = rateItem({ price, product: repos.products.get(price.productId), usage: evs, period });
      if (line) lines.push(line);
    }
    return lines;
  }

  async function takePending(sub, { peek = false } = {}) {
    const items = repos.pending.list((p) => p.subscriptionId === sub.id && !p.invoiceId);
    if (!peek) for (const p of items) await repos.pending.update(p.id, (x) => ({ ...x, invoiceId: 'taken' }));
    return items.map((p) => p.line);
  }

  /** Closes a subscription's current period if it has ended: one invoice, then the next period (or the end). */
  async function closePeriod(subId) {
    return subLock(subId, async () => {
      const sub = repos.subscriptions.get(subId);
      if (!sub || sub.status === 'cancelled' || Date.parse(sub.currentPeriod.end) > now()) return null;
      const account = pay().getAccount(sub.accountId);
      const period = sub.currentPeriod;
      const ending = sub.cancelAtPeriodEnd;
      const lines = await usageLines(sub, period);
      lines.push(...await takePending(sub));
      let nextPeriod = null;
      if (!ending) {
        const endMs = Date.parse(period.end);
        nextPeriod = periodFrom(endMs, cycleOf(sub));
        for (const it of sub.items) {
          const price = repos.prices.get(it.priceId);
          if (isMetered(price)) continue;
          const line = licensedLine(price, it.quantity, nextPeriod, sub);
          if (line.amount.amount) lines.push(line);
        }
      }
      const real = lines.filter((l) => l.amount.amount !== 0 || l.kind === 'usage');
      // Advance first: a failure while collecting must not bill the period twice.
      await repos.subscriptions.update(subId, (s) => ({
        ...s,
        ...(ending ? { status: 'cancelled', endedAt: period.end } : { currentPeriod: nextPeriod, status: s.status === 'trialing' ? 'active' : s.status }),
      }));
      if (real.length) await issueInvoice({ account, sub: repos.subscriptions.get(subId), period, lines: real, at: period.end, reason: 'subscription_cycle' });
      if (ending) events.emit('pay.subscription.cancelled', { subscriptionId: subId, accountId: sub.accountId, reason: sub.cancelReason ?? 'period_end' });
      return true;
    });
  }

  /** The period close job (spec §6): every subscription whose period has ended, as many periods as have passed. */
  async function closeDue() {
    let closed = 0;
    for (const sub of repos.subscriptions.list((s) => s.status !== 'cancelled')) {
      for (let i = 0; i < 400; i += 1) {
        if (!await closePeriod(sub.id)) break;
        closed += 1;
      }
    }
    return closed;
  }

  /** What the next invoice of a subscription looks like now (not saved): usage so far, pending lines, licensed ahead. */
  async function preview(subId) {
    const sub = repos.subscriptions.must(subId, 'The subscription');
    const account = pay().getAccount(sub.accountId);
    const period = sub.currentPeriod;
    const lines = await usageLines(sub, period, { upTo: now() });
    lines.push(...await takePending(sub, { peek: true }));
    if (!sub.cancelAtPeriodEnd && sub.status !== 'cancelled') {
      const nextPeriod = periodFrom(Date.parse(period.end), cycleOf(sub));
      for (const it of sub.items) {
        const price = repos.prices.get(it.priceId);
        if (!isMetered(price)) lines.push(licensedLine(price, it.quantity, nextPeriod, sub));
      }
    }
    const totals = totalsFor(lines, account);
    const applied = Math.min(account.creditBalance.amount, Math.max(totals.total.amount, 0));
    return {
      subscriptionId: sub.id, accountId: account.id, currency: account.currency, period, asOf: iso(),
      lines, ...totals,
      creditApplied: money(applied, account.currency), amountDue: money(Math.max(totals.total.amount, 0) - applied, account.currency),
    };
  }

  /** A one-off invoice: lines { description, amount (minor units), quantity? }. */
  async function createInvoice({ accountId, lines, finalize: fin = true, memo = null, collect = true }, ctx = SYSTEM) {
    assertCan(ctx, 'invoices.write');
    const account = pay().getAccount(accountId ?? '');
    const c = checker();
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) c.fail('lines', '1 to 100 lines.');
    (lines ?? []).forEach((l, i) => {
      if (!str(l?.description, 300)) c.fail(`lines.${i}.description`, 'Up to 300 characters.');
      if (!Number.isSafeInteger(l?.amount)) c.fail(`lines.${i}.amount`, 'Minor units (cents), whole.');
      if (l?.quantity !== undefined && !int(l.quantity, 1)) c.fail(`lines.${i}.quantity`, '1 or more.');
    });
    c.throwIfAny();
    const rated = lines.map((l) => ({ kind: 'one_off', description: l.description.trim(), priceId: null, quantity: l.quantity ?? 1, unitAmount: l.amount, amount: money(l.amount * (l.quantity ?? 1), account.currency), period: null }));
    const inv = await draft({ account, lines: rated, reason: 'manual', memo });
    await audit.record({ ctx, action: 'invoice.created', ref: { type: 'invoice', id: inv.id } });
    return fin ? finalize(inv.id, ctx, { collect: collect !== false }) : inv;
  }

  /** Voids an open invoice nobody has paid: the finalising postings are reversed and applied credit returned. */
  async function voidInvoice(invoiceId, ctx = SYSTEM) {
    assertCan(ctx, 'invoices.write');
    const inv = repos.invoices.must(invoiceId, 'The invoice');
    if (inv.status === 'draft') {
      const v = await repos.invoices.update(invoiceId, (i) => ({ ...i, status: 'void', voidedAt: iso() }));
      await audit.record({ ctx, action: 'invoice.voided', ref: { type: 'invoice', id: invoiceId } });
      return v;
    }
    if (inv.status !== 'open') throw conflict(`Only an open invoice can be voided; ${inv.number} is ${inv.status}.`);
    if (inv.amountPaid.amount > 0 || inv.credited.amount > 0) throw conflict('Part of this invoice is paid or credited: issue a credit note instead.');
    if (inv.total.amount < 0) throw conflict('An invoice that created credit cannot be voided.');
    const applied = inv.creditApplied.amount;
    await ledger.post({ accountId: inv.accountId, currency: inv.currency, ref: { type: 'invoice', id: inv.id }, memo: `Invoice ${inv.number} voided`, lines: [['receivable', -inv.total.amount], ['revenue', inv.net.amount], ['tax_payable', inv.tax.amount], ['customer_credit', -applied], ['receivable', applied]] });
    if (applied) await repos.accounts.update(inv.accountId, (a) => ({ ...a, creditBalance: money(a.creditBalance.amount + applied, a.currency) }));
    const v = await repos.invoices.update(invoiceId, (i) => ({ ...i, status: 'void', voidedAt: iso(), nextAttemptAt: null, amountRemaining: money(0, i.currency) }));
    await audit.record({ ctx, action: 'invoice.voided', ref: { type: 'invoice', id: invoiceId }, details: { number: inv.number, total: inv.total } });
    events.emit('pay.invoice.voided', { invoiceId, accountId: inv.accountId, number: inv.number });
    return v;
  }

  async function sendInvoice(invoiceId, ctx = SYSTEM) {
    assertCan(ctx, 'invoices.send');
    const inv = repos.invoices.must(invoiceId, 'The invoice');
    if (inv.status === 'draft') throw conflict('Finalise the invoice before sending it.');
    const sent = await S.notifier.send('invoice.ready', { account: pay().getAccount(inv.accountId), invoice: inv, url: pay().invoiceUrl(invoiceId), idempotencyKey: `pay:send:${invoiceId}:${now()}` });
    await audit.record({ ctx, action: 'invoice.sent', ref: { type: 'invoice', id: invoiceId }, details: { sent } });
    return { sent };
  }

  /**
   * A credit note on a finalised invoice (spec §6): on an open invoice it lowers what is left to pay; on a paid one it
   * becomes account credit, or a refund to the card (`refund: true`).
   */
  async function creditNote({ invoiceId, amount, reason, refund = false, idempotencyKey = null }, ctx = SYSTEM) {
    assertCan(ctx, 'credit_notes.write');
    const inv = repos.invoices.must(invoiceId ?? '', 'The invoice');
    if (!['open', 'paid'].includes(inv.status)) throw conflict(`A credit note needs an open or paid invoice; ${inv.number ?? inv.id} is ${inv.status}.`);
    const left = inv.total.amount - inv.credited.amount;
    const c = checker();
    if (!int(amount, 1) || amount > left) c.fail('amount', `Minor units, 1 to ${left}.`);
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) c.fail('reason', 'Say why, in 3 to 500 characters.');
    if (refund && inv.status !== 'paid') c.fail('refund', 'Only a paid invoice can be refunded.');
    if (inv.status === 'open' && amount > inv.amountRemaining.amount) c.fail('amount', `At most what is left to pay (${inv.amountRemaining.amount}).`);
    c.throwIfAny();
    const tax = inv.total.amount ? mulDiv(amount, inv.tax.amount, inv.total.amount) : 0;
    const net = amount - tax;
    const account = pay().getAccount(inv.accountId);
    const number = await nextNumber('CN', inv.currency, new Date(now()).getUTCFullYear());
    const note = await repos.creditNotes.insert({ id: newId('cn'), number, invoiceId, accountId: inv.accountId, amount: money(amount, inv.currency), net: money(net, inv.currency), tax: money(tax, inv.currency), reason: reason.trim(), refundId: null, by: ctx.actor ?? null });
    const toCredit = inv.status === 'paid';
    await ledger.post({ accountId: inv.accountId, currency: inv.currency, ref: { type: 'credit_note', id: note.id }, memo: `Credit note ${number}`, lines: [['revenue', net], ['tax_payable', tax], [toCredit ? 'customer_credit' : 'receivable', -amount]] });
    await repos.invoices.update(invoiceId, (i) => ({ ...i, credited: money(i.credited.amount + amount, i.currency), ...(toCredit ? {} : { amountRemaining: money(i.amountRemaining.amount - amount, i.currency) }) }));
    if (toCredit) {
      await repos.accounts.update(account.id, (a) => ({ ...a, creditBalance: money(a.creditBalance.amount + amount, a.currency) }));
      if (refund) {
        const paymentId = inv.paymentId ?? repos.payments.list((p) => p.invoiceId === invoiceId && p.status === 'succeeded')[0]?.id;
        if (!paymentId) throw conflict('No card payment was found for this invoice to refund.');
        const r = await pay().refund({ paymentId, amount, reason, idempotencyKey: idempotencyKey ? `cn:${idempotencyKey}` : `cn:${note.id}`, viaCredit: true }, SYSTEM);
        await repos.accounts.update(account.id, (a) => ({ ...a, creditBalance: money(a.creditBalance.amount - amount, a.currency) }));
        await repos.creditNotes.update(note.id, (n) => ({ ...n, refundId: r.id }));
      }
    } else if (repos.invoices.get(invoiceId).amountRemaining.amount === 0) {
      await pay().markPaid(invoiceId);
    }
    await audit.record({ ctx, action: 'credit_note.created', ref: { type: 'invoice', id: invoiceId }, details: { creditNoteId: note.id, amount: note.amount, reason: note.reason, refund } });
    events.emit('pay.credit_note.created', { creditNoteId: note.id, invoiceId, accountId: inv.accountId, amount: note.amount, refund });
    return repos.creditNotes.get(note.id);
  }

  /** Everything the BillingSummary component draws for one account. */
  async function summary(accountId) {
    const account = pay().getAccount(accountId);
    const sub = repos.subscriptions.list((s) => s.accountId === accountId && s.status !== 'cancelled').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
    const invoices = repos.invoices.list((i) => i.accountId === accountId && i.status !== 'draft')
      .sort((a, b) => ((a.finalizedAt ?? '') < (b.finalizedAt ?? '') ? 1 : -1)).slice(0, 24)
      .map((i) => ({ id: i.id, number: i.number, status: i.status, period: i.period, total: i.total, amountRemaining: i.amountRemaining, finalizedAt: i.finalizedAt, paidAt: i.paidAt, nextAttemptAt: i.nextAttemptAt, attempts: i.attempts, url: pay().invoiceUrl(i.id) }));
    return {
      account: { id: account.id, name: account.name, email: account.email, currency: account.currency, country: account.country, taxId: account.taxId, address: account.address, status: account.status, creditBalance: account.creditBalance, defaultMethodId: account.defaultMethodId },
      methods: pay().listMethods(accountId).map((m) => ({ id: m.id, ...m.display, isDefault: m.id === account.defaultMethodId })),
      subscription: sub && { id: sub.id, status: sub.status, currentPeriod: sub.currentPeriod, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, paused: Boolean(sub.pausedAt) },
      upcoming: sub ? await preview(sub.id) : null,
      invoices,
    };
  }

  return {
    createMeter, createProduct, updateProduct, createPrice, updatePrice, ensureCatalogue, currentPrice,
    listMeters: () => repos.meters.list(), listProducts: () => repos.products.list(), listPrices: (test) => repos.prices.list(test),
    recordUsage, usageFor,
    subscribe, updateItems, cancel, cancelNow, pause, resume, preview,
    getSubscription: (id) => repos.subscriptions.must(id, 'The subscription'),
    listSubscriptions: (test) => repos.subscriptions.list(test),
    createInvoice, finalize, voidInvoice, sendInvoice, creditNote, closeDue, closePeriod, totalsFor,
    getInvoice: (id) => repos.invoices.must(id, 'The invoice'),
    listInvoices: (test) => repos.invoices.list(test),
    listCreditNotes: (test) => repos.creditNotes.list(test),
    summary,
  };
}

export { nextBoundary };
