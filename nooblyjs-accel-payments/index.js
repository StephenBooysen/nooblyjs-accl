// nooblyjs-accel-payments: charge an application's customers (steering §1). A library: the host owns Express, the shared
// EventEmitter and the nooblyjs-core ServiceRegistry, and calls mount(app, eventEmitter, serviceRegistry, options)
// (spec §3). Everything is checked before anything is mounted; mount() never listens on a port and never initialises
// the registry; shutdown() is idempotent.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRepo } from './src/shared/store.js';
import { createLedger } from './src/shared/ledger.js';
import { createEvents, createAudit, createIdempotency, contextResolver, systemClock, createTestClock, systemContext, SYSTEM, ROLES, PERMISSIONS, EVENT_TYPES } from './src/shared/runtime.js';
import { isCurrency } from './src/shared/money.js';
import { createMockProvider } from './src/providers/mock.js';
import { createStripeProvider } from './src/providers/stripe.js';
import { missingFunctions } from './src/providers/contract.js';
import { createUsageStore } from './src/billing/usage.js';
import { createBillingService } from './src/billing/service.js';
import { createPaymentsService, createWork } from './src/payments/service.js';
import { createNotifier } from './src/payments/notify.js';
import { paymentsRouter, billingRouter } from './src/routes/api.js';
import { publicRouter } from './src/routes/public.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MODULES = { payments: [], billing: ['payments'] };
const DEV_SECRET = 'nooblyjs-payments-development-signing-secret';

/** Checks and fills in the options; throws before anything is mounted. */
export function normaliseOptions(options = {}, env = process.env) {
  const production = env.NODE_ENV === 'production';
  const o = {
    modules: ['payments', 'billing'], basePath: '/admin', containerPrefix: 'pay', currency: 'USD', brand: 'NooblyJS',
    bodyLimit: '256kb', ui: true, publicUrl: null, seller: null,
    ...options,
  };
  const fail = (m) => { throw new Error(`payments mount: ${m}`); };
  if (!Array.isArray(o.modules) || !o.modules.length) fail('modules is a non-empty array.');
  for (const m of o.modules) {
    if (!MODULES[m]) fail(`unknown module '${m}' (payments, billing).`);
    for (const dep of MODULES[m]) if (!o.modules.includes(dep)) fail(`module '${m}' requires '${dep}'.`);
  }
  if (typeof o.basePath !== 'string' || !/^(\/[A-Za-z0-9_-]+)*$/.test(o.basePath)) fail("basePath looks like '/admin' (no trailing slash), or '' for the root.");
  if (!/^[a-z][a-z0-9]{0,15}$/.test(o.containerPrefix)) fail('containerPrefix is 1-16 lower-case letters or digits.');
  if (!isCurrency(o.currency)) fail('currency is an ISO 4217 code such as USD.');
  if (o.publicUrl !== null && !/^https?:\/\/[^/\s]+$/.test(o.publicUrl)) fail('publicUrl is an origin such as https://cloud.example (no path).');
  const tax = { rates: [], ...(options.tax ?? {}) };
  for (const r of tax.rates) {
    if (!/^[A-Z]{2}$/.test(r.country ?? '') || !Number.isInteger(r.rate) || r.rate < 0 || r.rate > 10_000 || typeof r.name !== 'string') fail('tax.rates are { country: "ZA", rate: 1500 (basis points), inclusive?: boolean, name: "VAT" }.');
  }
  const dunning = { retryDays: [1, 3, 5, 7], finalAction: 'mark-uncollectible', ...(options.dunning ?? {}) };
  if (!Array.isArray(dunning.retryDays) || dunning.retryDays.length > 10 || dunning.retryDays.some((d, i) => !Number.isInteger(d) || d < 1 || d > 60 || (i && d <= dunning.retryDays[i - 1]))) fail('dunning.retryDays is up to 10 ascending whole days (1-60).');
  if (!['mark-uncollectible', 'cancel-subscription'].includes(dunning.finalAction)) fail('dunning.finalAction is mark-uncollectible or cancel-subscription.');
  const support = { refundLimit: 5000, ...(options.support ?? {}) };
  if (!Number.isInteger(support.refundLimit) || support.refundLimit < 0) fail('support.refundLimit is minor units.');
  const jobs = { enabled: true, intervalMs: 60_000, ...(options.jobs ?? {}) };
  const provider = options.provider ?? { type: 'mock' };
  const type = provider.type ?? (typeof provider.name === 'string' ? 'custom' : null);
  if (!['mock', 'stripe', 'custom'].includes(type)) fail('provider is { type: "mock" } or { type: "stripe", secretKey, webhookSecret, publishableKey }, or a provider object.');
  if (type === 'mock' && production && !options.allowMockInProduction) fail('the mock provider is refused in production (NODE_ENV=production).');
  if (type === 'stripe') {
    const secretKey = provider.secretKey ?? env.STRIPE_SECRET_KEY;
    const webhookSecret = provider.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) fail('the Stripe provider needs secretKey and webhookSecret (or STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET).');
  }
  if (type === 'custom') {
    const missing = missingFunctions(provider);
    if (missing.length) fail(`the provider lacks ${missing.join(', ')}.`);
  }
  const signingSecret = options.signingSecret ?? env.PAY_SIGNING_SECRET ?? (production ? null : DEV_SECRET);
  if (!signingSecret || signingSecret.length < 16) fail('signingSecret (or PAY_SIGNING_SECRET), 16 characters or more, signs hosted invoice and payment links.');
  if (o.notify !== undefined && typeof o.notify !== 'function') fail('notify is a function (kind, data).');
  return { ...o, tax, dunning, support, jobs, provider: { ...provider, type }, signingSecret, auth: { ...(options.auth ?? {}) }, production };
}

function buildProvider(p, clock, env) {
  if (p.type === 'mock') return createMockProvider({ clock, webhookSecret: p.webhookSecret ?? 'whsec_mock' });
  if (p.type === 'stripe') {
    return createStripeProvider({
      secretKey: p.secretKey ?? env.STRIPE_SECRET_KEY, webhookSecret: p.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET,
      publishableKey: p.publishableKey ?? env.STRIPE_PUBLISHABLE_KEY ?? null, apiBase: p.apiBase, fetch: p.fetch, clock,
    });
  }
  return p;
}

/**
 * @param {import('express').Express} app
 * @param {import('node:events').EventEmitter} eventEmitter
 * @param {object} serviceRegistry   nooblyjs-core, initialised by the host
 * @param {object} [options]         spec §3
 */
export async function mount(app, eventEmitter, serviceRegistry, options = {}) {
  if (!app || typeof app.use !== 'function') throw new Error('payments mount: an Express app is required.');
  if (!eventEmitter || typeof eventEmitter.emit !== 'function') throw new Error('payments mount: an EventEmitter is required.');
  if (!serviceRegistry || typeof serviceRegistry.dataService !== 'function') throw new Error('payments mount: a nooblyjs-core ServiceRegistry is required.');
  if (serviceRegistry.initialized === false) throw new Error('payments mount: initialise the serviceRegistry before mount().');
  const env = options.env ?? process.env;
  const opts = normaliseOptions(options, env);
  const express = options.express ?? (await import('express')).default;
  if (typeof express?.Router !== 'function') throw new Error('payments mount: options.express is the host\'s express module.');
  const clock = options.clock ?? systemClock;
  const p = opts.providers ?? {};
  const pick = (key, fallback) => ({ type: p[key]?.type ?? fallback, options: p[key]?.options ?? {} });
  const data = pick('data', 'memory');
  const logging = pick('logging', 'console');
  const log = options.log ?? serviceRegistry.logger?.(logging.type, { instanceName: 'payments', ...logging.options }) ?? console;
  const dataService = serviceRegistry.dataService(data.type, { instanceName: 'payments', ...data.options });
  let notifying = null;
  try {
    notifying = serviceRegistry.notifying?.(pick('notifying', 'memory').type, { instanceName: 'payments' }) ?? null;
  } catch { /* events still go on the emitter */ }
  const provider = buildProvider(opts.provider, clock, env);

  const prefix = opts.containerPrefix;
  const repo = (name, unique) => createRepo(dataService, `${prefix}_${name}`, clock, { unique });
  const repos = {
    accounts: repo('accounts', { externalRef: (a) => a.externalRef }),
    methods: repo('methods'), setups: repo('setups'),
    meters: repo('meters', { key: (m) => m.key }),
    products: repo('products', { key: (x) => x.key }),
    prices: repo('prices', { key: (x) => x.key }),
    subscriptions: repo('subscriptions'), pending: repo('pending_items'),
    invoices: repo('invoices', { number: (i) => i.number }),
    creditNotes: repo('credit_notes'), payments: repo('payments'), refunds: repo('refunds'),
    ledger: repo('ledger'), webhooks: repo('webhooks'), idempotency: repo('idempotency'), audit: repo('audit'),
    counters: repo('counters'), issues: repo('issues'),
  };
  await Promise.all(Object.values(repos).map((r) => r.init()));

  const events = createEvents({ eventEmitter, notifying, clock, log });
  const audit = createAudit({ repo: repos.audit, clock });
  const S = {
    version, options: opts, clock, log, repos, provider, events, audit,
    ledger: createLedger({ repo: repos.ledger, clock }),
    idempotency: createIdempotency({ repo: repos.idempotency, clock }),
    usage: createUsageStore({ dataService, prefix, clock }),
    work: createWork(log),
  };
  S.notifier = createNotifier({ customers: options.customers, notify: opts.notify, brand: opts.brand, billingUrl: options.billingUrl, log, audit });
  S.paymentsService = createPaymentsService(S);
  S.billingService = opts.modules.includes('billing') ? createBillingService(S) : null;
  S.billing = S.billingService;
  const contextOf = contextResolver({ roleResolver: opts.auth.roleResolver, apiKeys: opts.auth.apiKeys ?? [] });

  // Routes: the public ones first (the webhook's raw body is read before any JSON parser), then the APIs and screens.
  const base = `${opts.basePath}/payments`;
  app.use(`${base}/p`, publicRouter({ express, S }));
  app.use(`${base}/api/v1`, paymentsRouter({ express, S, contextOf }));
  if (S.billingService) app.use(`${opts.basePath}/billing/api/v1`, billingRouter({ express, S, contextOf }));
  app.use(`${base}/components`, express.static(path.join(ROOT, 'src', 'components'), { index: false, redirect: false }));
  if (opts.ui !== false) app.use(`${base}`, express.static(path.join(ROOT, 'src', 'views'), { index: 'index.html', redirect: false }));

  const unsubscribeMock = provider.name === 'mock' ? provider.subscribe((body, headers) => S.paymentsService.receiveWebhook('mock', body, headers)) : null;
  // The email templates exist before the first notice (an operator's edits to them are kept).
  if (options.customers) await S.notifier.ensureTemplates().catch((err) => log?.warn?.(`[accel-payments] email templates: ${err.message}`));

  // The jobs (spec §6): period close, dunning retries, and once a day the expiring-card notices.
  let ticking = null;
  let lastExpiringDay = null;
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        if (S.billingService) await S.billingService.closeDue();
        await S.paymentsService.runDunning();
        const today = new Date(clock.now()).toISOString().slice(0, 10);
        if (today !== lastExpiringDay) {
          lastExpiringDay = today;
          await S.paymentsService.checkExpiring();
          await S.idempotency.sweep();
        }
        await S.work.idle();
      } catch (err) {
        log?.error?.(`[accel-payments] jobs: ${err.stack ?? err.message}`);
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }
  const timer = opts.jobs.enabled ? setInterval(tick, opts.jobs.intervalMs) : null;
  timer?.unref?.();

  const P = S.paymentsService;
  const B = S.billingService;
  const payments = {
    ensureAccount: P.ensureAccount, createAccount: P.createAccount, updateAccount: P.updateAccount, getAccount: P.getAccount, lookup: P.lookup, listAccounts: P.listAccounts,
    setupMethod: P.setupMethod, confirmMethod: P.confirmMethod, makeDefault: P.makeDefault, removeMethod: P.removeMethod, listMethods: P.listMethods,
    collect: P.collect, payInvoice: (invoiceId, o = {}) => P.collect(invoiceId, o), refund: P.refund,
    listPayments: P.listPayments, listRefunds: P.listRefunds, listIssues: P.listIssues, resolveIssue: P.resolveIssue,
    receiveWebhook: P.receiveWebhook, completeAction: P.completeAction, invoiceUrl: P.invoiceUrl, actionUrl: P.actionUrl,
    ledger: { entries: S.ledger.entries, balances: S.ledger.balances, unbalanced: S.ledger.unbalanced },
  };
  const billing = B && {
    ensureAccount: P.ensureAccount, setupMethod: P.setupMethod, confirmMethod: P.confirmMethod, refund: P.refund,
    ensureCatalogue: B.ensureCatalogue, currentPrice: B.currentPrice, createMeter: B.createMeter, createProduct: B.createProduct, createPrice: B.createPrice, updatePrice: B.updatePrice,
    listMeters: B.listMeters, listProducts: B.listProducts, listPrices: B.listPrices,
    subscribe: B.subscribe, changePlan: B.updateItems, updateItems: B.updateItems, cancel: B.cancel, pause: B.pause, resume: B.resume,
    getSubscription: B.getSubscription, listSubscriptions: B.listSubscriptions,
    recordUsage: B.recordUsage, usageFor: B.usageFor, previewInvoice: B.preview,
    createInvoice: B.createInvoice, finalize: B.finalize, voidInvoice: B.voidInvoice, sendInvoice: B.sendInvoice, creditNote: B.creditNote,
    getInvoice: B.getInvoice, listInvoices: B.listInvoices, listCreditNotes: B.listCreditNotes, payInvoice: payments.payInvoice,
    summary: B.summary, closeDue: B.closeDue, totalsFor: B.totalsFor,
  };

  let closed = false;
  log?.info?.(`[accel-payments] mounted ${opts.modules.join(', ')} at ${opts.basePath || '/'} with the ${provider.name} provider (v${version})`);
  return {
    name: 'payments',
    version,
    options: { ...opts, signingSecret: undefined, provider: { type: opts.provider.type }, auth: undefined, notify: undefined },
    events,
    audit,
    payments,
    billing,
    /** The provider's settings for a card form (never a secret). */
    client: () => provider.clientConfig(),
    /** The mock provider's controls (test cards, failure injection, out-of-band events); null on a real provider. */
    mock: provider.name === 'mock' ? provider : null,
    components: { cardForm: `${base}/components/card-form.js`, billingSummary: `${base}/components/billing-summary.js` },
    /** Paths a host must leave open without a sign-in: provider webhooks, hosted invoices and payment hand-offs, components. */
    publicPaths: [`${base}/p`, `${base}/components`],
    tick,
    idle: () => S.work.idle(),
    context: { system: systemContext },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unsubscribeMock?.();
      await ticking;
      await S.work.idle();
      events.close();
    },
  };
}

export default { mount, version };
export { createTestClock, createMockProvider, createStripeProvider, missingFunctions, ROLES, PERMISSIONS, EVENT_TYPES, SYSTEM };
export * as money from './src/shared/money.js';
export { rateItem, monthHours, graduated, aggregate } from './src/billing/rating.js';
export { prorate, prorationLines, nextBoundary, periodFrom } from './src/billing/proration.js';
export { invoiceHtml, invoicePdf } from './src/billing/document.js';
export { TEST_CARDS } from './src/providers/mock.js';
