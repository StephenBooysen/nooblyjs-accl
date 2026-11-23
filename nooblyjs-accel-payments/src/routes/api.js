// The HTTP API (spec §7): {basePath}/payments/api/v1 and {basePath}/billing/api/v1. Actions use the spec's colon form
// (POST /invoices/in_123:finalize); a path segment holds both, so the routes work the same on Express 4 and 5.
// Lists: filter[field]=value, sort, limit, offset → { items, total, limit, offset }. Money-moving routes need an
// Idempotency-Key.
import { guarded, filtersOf, matches, ifMatch, reply, errorHandler, wrap } from '../shared/http.js';
import { assertCan } from '../shared/runtime.js';
import { page } from '../shared/store.js';
import { invalid, notFound } from '../shared/errors.js';
import { invoicePdf } from '../billing/document.js';
import { openapi } from './openapi.js';

const split = (ref) => {
  const i = ref.indexOf(':');
  return i === -1 ? [ref, null] : [ref.slice(0, i), ref.slice(i + 1)];
};
const listOf = (items, req) => page(items.filter((x) => matches(x, filtersOf(req.query))), { limit: req.query.limit, offset: req.query.offset, sort: typeof req.query.sort === 'string' ? req.query.sort : undefined });

/**
 * @param {object} o
 * @param {object} o.express          the host's express module
 * @param {object} o.S                shared state
 * @param {(req) => object} o.contextOf
 */
/** A payment with the card it used and its refunds, for the order and refund screens. */
const detailOf = (S) => (p) => ({ ...p, method: p.methodId ? S.repos.methods.get(p.methodId)?.display ?? null : null, refunds: S.paymentsService.listRefunds((r) => r.paymentId === p.id) });

export function paymentsRouter({ express, S, contextOf }) {
  const router = express.Router();
  const P = S.paymentsService;
  const withDetail = detailOf(S);
  const route = guarded({ contextOf, idempotency: S.idempotency, audit: S.audit });
  router.use(express.json({ limit: S.options.bodyLimit }));

  router.get('/health', (req, res) => res.json({ status: 'ok', module: 'payments', provider: S.provider.name, version: S.version }));
  router.get('/openapi.json', (req, res) => res.json(openapi('payments', S)));

  router.get('/accounts', route('read', (req) => listOf(P.listAccounts(), req)));
  router.post('/accounts', route('accounts.write', async (req, ctx) => reply(201, await P.createAccount(req.body ?? {}, ctx))));
  router.get('/accounts/:id', route('read', (req) => P.getAccount(req.params.id)));
  router.patch('/accounts/:id', route('accounts.write', (req, ctx) => P.updateAccount(req.params.id, req.body ?? {}, ctx, { expectedVersion: ifMatch(req) })));
  router.get('/accounts/:id/methods', route('read', (req) => ({ items: P.listMethods(P.getAccount(req.params.id).id) })));
  router.post('/accounts/:id/:sub', route('methods.write', async (req, ctx) => {
    if (req.params.sub !== 'methods:setup') throw notFound('That route');
    return reply(201, await P.setupMethod(req.params.id, req.body ?? {}, ctx));
  }));
  router.post('/accounts/:id/methods/:ref', route('methods.write', async (req, ctx) => {
    const [ref, action] = split(req.params.ref);
    if (action === 'confirm') return P.confirmMethod(req.params.id, ref, req.body ?? {}, ctx);
    if (action === 'make-default') return P.makeDefault(req.params.id, ref, ctx);
    throw notFound('That action');
  }));
  router.delete('/accounts/:id/methods/:ref', route('methods.write', (req, ctx) => P.removeMethod(req.params.id, req.params.ref, ctx)));
  router.get('/accounts/:id/ledger', route('read', (req) => {
    const account = P.getAccount(req.params.id);
    return { items: S.ledger.entries({ accountId: account.id }), balances: S.ledger.balances({ accountId: account.id, currency: account.currency }) };
  }));
  router.get('/accounts/:id/audit', route('read', (req) => ({ items: S.audit.list({ refId: req.params.id }) })));

  router.get('/payments', route('read', (req) => listOf(P.listPayments(), req)));
  router.get('/payments/:id', route('read', (req) => withDetail(S.repos.payments.must(req.params.id, 'The payment'))));
  router.get('/refunds', route('read', (req) => listOf(P.listRefunds(), req)));
  router.post('/refunds', route('refunds.write', async (req, ctx) => reply(201, await P.refund({ ...(req.body ?? {}), idempotencyKey: req.get('idempotency-key') }, ctx)), { idempotent: true, scope: 'refunds' }));

  router.get('/dunning', route('read', (req) => listOf(S.repos.invoices.list((i) => (i.status === 'open' && (i.attempts ?? 0) > 0) || (i.status === 'uncollectible' && i.final)), { ...req, query: { sort: 'nextAttemptAt', ...req.query } })));
  router.get('/reconciliation/issues', route('read', (req) => listOf(P.listIssues(), req)));
  router.post('/reconciliation/issues/:ref', route('invoices.write', (req, ctx) => {
    const [id, action] = split(req.params.ref);
    if (action !== 'resolve') throw notFound('That action');
    return P.resolveIssue(id, ctx);
  }));
  router.get('/provider', route('read', async () => ({
    ...(await S.provider.describe?.() ?? { name: S.provider.name, label: S.provider.name, mode: 'test', account: null }),
    brand: S.options.brand,
    webhookUrl: `${S.options.publicUrl ?? ''}${S.options.basePath}/payments/p/webhooks/${S.provider.name}`,
    received: S.repos.webhooks.count(),
    lastEventAt: S.repos.webhooks.list().map((w) => w.receivedAt).sort().at(-1) ?? null,
  })));
  router.get('/webhooks', route('read', (req) => listOf(S.repos.webhooks.list(), { ...req, query: { sort: '-receivedAt', ...req.query } })));
  router.get('/audit', route('read', (req) => ({ items: S.audit.list({ action: req.query.action, limit: Math.min(Number(req.query.limit) || 100, 500) }) })));
  router.get('/overview', route('read', () => overview(S)));
  // Last of the one-segment routes: GET /accounts:lookup?externalRef=…
  router.get('/:collection', route('read', (req) => {
    if (req.params.collection !== 'accounts:lookup') throw notFound('That route');
    const account = P.lookup(String(req.query.externalRef ?? ''));
    if (!account) throw notFound('The account');
    return account;
  }));

  router.use(errorHandler(S.log));
  return router;
}

export function billingRouter({ express, S, contextOf }) {
  const router = express.Router();
  const B = S.billingService;
  const P = S.paymentsService;
  const withDetail = detailOf(S);
  const route = guarded({ contextOf, idempotency: S.idempotency, audit: S.audit });
  router.use(express.json({ limit: S.options.bodyLimit }));

  router.get('/health', (req, res) => res.json({ status: 'ok', module: 'billing', version: S.version }));
  router.get('/openapi.json', (req, res) => res.json(openapi('billing', S)));

  router.get('/meters', route('read', (req) => listOf(B.listMeters(), req)));
  router.post('/meters', route('catalogue.write', async (req, ctx) => reply(201, await B.createMeter(req.body ?? {}, ctx))));
  router.get('/products', route('read', (req) => listOf(B.listProducts(), req)));
  router.post('/products', route('catalogue.write', async (req, ctx) => reply(201, await B.createProduct(req.body ?? {}, ctx))));
  router.patch('/products/:id', route('catalogue.write', (req, ctx) => B.updateProduct(req.params.id, req.body ?? {}, ctx)));
  router.get('/prices', route('read', (req) => listOf(B.listPrices(), req)));
  router.post('/prices', route('catalogue.write', async (req, ctx) => reply(201, await B.createPrice(req.body ?? {}, ctx))));
  router.patch('/prices/:id', route('catalogue.write', (req, ctx) => B.updatePrice(req.params.id, req.body ?? {}, ctx)));
  router.get('/tax-rates', route('read', () => ({ items: S.options.tax.rates })));

  router.get('/subscriptions', route('read', (req) => listOf(B.listSubscriptions(), req)));
  router.post('/subscriptions', route('subscriptions.write', async (req, ctx) => reply(201, await B.subscribe(req.body ?? {}, ctx)), { idempotent: true, scope: 'subscriptions' }));
  router.get('/subscriptions/:id', route('read', (req) => B.getSubscription(req.params.id)));
  router.get('/subscriptions/:id/preview', route('read', (req) => B.preview(req.params.id)));
  router.post('/subscriptions/:ref', route('subscriptions.write', async (req, ctx) => {
    const [id, action] = split(req.params.ref);
    const body = req.body ?? {};
    if (action === 'change') return B.updateItems(id, { items: body.items, prorate: body.prorate ?? 'next' }, ctx);
    if (action === 'cancel') return B.cancel(id, { atPeriodEnd: body.atPeriodEnd !== false, reason: body.reason ?? 'requested' }, ctx);
    if (action === 'pause') return B.pause(id, ctx);
    if (action === 'resume') return B.resume(id, ctx);
    throw notFound('That action');
  }, { idempotent: true, scope: 'subscription-actions' }));

  router.post('/usage', route('usage.write', async (req, ctx) => {
    const body = req.body ?? {};
    return reply(202, await B.recordUsage(Array.isArray(body.events) ? body.events : body, ctx));
  }));
  router.get('/accounts/:id/usage', route('read', async (req) => {
    const account = P.getAccount(req.params.id);
    let { from, to } = req.query;
    if (typeof req.query.period === 'string') {
      const m = /^(\d{4})-(\d{2})$/.exec(req.query.period);
      if (!m) throw invalid('period is YYYY-MM.', [{ path: 'period', message: 'YYYY-MM.' }]);
      from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toISOString();
      to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)).toISOString();
    }
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) throw invalid('Send from and to (ISO), or period (YYYY-MM).');
    return { accountId: account.id, from, to, meters: await B.usageFor(account.id, { from, to }) };
  }));
  router.get('/accounts/:id/summary', route('read', (req) => B.summary(req.params.id)));

  router.get('/invoices', route('read', (req) => listOf(B.listInvoices(), req)));
  router.post('/invoices', route('invoices.write', async (req, ctx) => reply(201, await B.createInvoice(req.body ?? {}, ctx)), { idempotent: true, scope: 'invoices' }));
  // GET /invoices/in_123.pdf: the PDF.
  router.get('/invoices/:ref', wrap(async (req, res, next) => {
    if (!req.params.ref.endsWith('.pdf')) return next();
    const ctx = contextOf(req);
    assertCan(ctx, 'read');
    const inv = B.getInvoice(req.params.ref.slice(0, -4));
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${inv.number ?? inv.id}.pdf"`).send(invoicePdf(inv, { brand: S.options.brand }));
  }));
  router.get('/invoices/:ref', route('read', (req) => {
    const inv = B.getInvoice(req.params.ref);
    return { ...inv, url: inv.status === 'draft' ? null : P.invoiceUrl(inv.id), payments: P.listPayments((p) => p.invoiceId === inv.id).map(withDetail), creditNotes: B.listCreditNotes((n) => n.invoiceId === inv.id) };
  }));
  router.post('/invoices/:ref', route('invoices.write', async (req, ctx) => {
    const [id, action] = split(req.params.ref);
    if (action === 'finalize') return B.finalize(id, ctx);
    if (action === 'pay') return P.collect(id, { methodId: req.body?.methodId ?? null, ctx });
    if (action === 'void') return B.voidInvoice(id, ctx);
    if (action === 'mark-uncollectible') return P.markUncollectible(id, ctx);
    throw notFound('That action');
  }, { idempotent: true, scope: 'invoice-actions' }));
  router.post('/invoices/:ref/send', route('invoices.send', (req, ctx) => B.sendInvoice(req.params.ref, ctx)));
  router.get('/credit-notes', route('read', (req) => listOf(B.listCreditNotes(), req)));
  router.post('/credit-notes', route('credit_notes.write', async (req, ctx) => reply(201, await B.creditNote({ ...(req.body ?? {}), idempotencyKey: req.get('idempotency-key') }, ctx)), { idempotent: true, scope: 'credit-notes' }));

  router.use(errorHandler(S.log));
  return router;
}

/** Revenue, open and overdue, failed payments, MRR (a first cut of the reporting module's Overview). */
export function overview(S) {
  const { repos, clock, options } = S;
  const now = clock.now();
  const d = new Date(now);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const currency = options.currency;
  const inCur = (m) => m?.currency === currency;
  const paidThisMonth = repos.invoices.list((i) => i.status === 'paid' && i.paidAt >= monthStart && inCur(i.total)).reduce((s, i) => s + i.amountPaid.amount, 0);
  const open = repos.invoices.list((i) => i.status === 'open' && inCur(i.total));
  const overdue = open.filter((i) => (i.attempts ?? 0) > 0);
  const lastMonthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString();
  const mrr = repos.invoices.list((i) => i.subscriptionId && i.reason === 'subscription_cycle' && i.period?.start >= lastMonthStart && i.period?.start < monthStart && ['paid', 'open'].includes(i.status) && inCur(i.total)).reduce((s, i) => s + i.net.amount, 0);
  return {
    currency,
    revenueThisMonth: { amount: paidThisMonth, currency },
    open: { count: open.length, amount: { amount: open.reduce((s, i) => s + i.amountRemaining.amount, 0), currency } },
    overdue: { count: overdue.length, amount: { amount: overdue.reduce((s, i) => s + i.amountRemaining.amount, 0), currency } },
    failedPayments30d: repos.payments.count((p) => p.status === 'failed' && Date.parse(p.createdAt) > now - 30 * 864e5),
    mrr: { amount: mrr, currency },
    accounts: { total: repos.accounts.count(), delinquent: repos.accounts.count((a) => a.status === 'delinquent') },
    openIssues: repos.issues.count((i) => i.status === 'open'),
    ledgerBalanced: S.ledger.unbalanced().length === 0,
  };
}
