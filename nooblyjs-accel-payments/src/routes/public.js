// Public routes, no session (spec §7): {basePath}/payments/p
//   POST /webhooks/:provider      raw body, signature checked, de-duplicated (mounted before any JSON parser)
//   GET  /invoices/:token         the hosted checkout (a signed link; ?return= the host's page to go back to), and
//                                 /invoices/:token/pdf; POST /invoices/:token/setup and /pay pay it with a new card
//   GET  /actions/:token          the 3-D Secure hand-off; POST /actions/:token/complete
//   GET  /mock/fields, POST /mock/setups   the mock provider's hosted fields stand-in (mock provider only)
//   GET  /assets/:file            the stylesheet and scripts of these pages (no inline code: core's CSP)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrap, errorHandler } from '../shared/http.js';
import { notFound, PayError, ProviderError } from '../shared/errors.js';
import { format } from '../shared/money.js';
import { invoicePdf } from '../billing/document.js';
import { checkoutHtml, successHtml, closedHtml, publicPage } from '../billing/checkout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'public');
const THEME = path.join(HERE, '..', 'views', 'css', 'styles.css');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


export function publicRouter({ express, S }) {
  const router = express.Router();
  const P = S.paymentsService;
  const brand = S.options.brand;

  router.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.rawBody === 'string' ? req.rawBody : Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
    if (raw === null) throw new PayError(400, 'raw_body_missing', 'The webhook body was parsed before it reached the payments accelerator: mount it before any JSON parser.');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v]));
    res.json(await P.receiveWebhook(req.params.provider, raw, headers));
  }));

  router.get('/assets/styles.css', (req, res) => res.sendFile(THEME, { maxAge: '1h' }));
  router.use('/assets', express.static(ASSETS, { index: false, redirect: false, maxAge: '1h' }));

  let described = null;
  const providerOf = async () => (described ??= (await S.provider.describe?.()) ?? { label: S.provider.name, mode: 'test' });
  const invoiceOf = (token) => {
    const p = P.tokens.read(token, 'i');
    const inv = p && S.repos.invoices.get(p.i);
    if (!inv || inv.status === 'draft') throw notFound('This invoice');
    return inv;
  };
  const payable = (inv) => ['open', 'uncollectible'].includes(inv.status) && inv.amountRemaining.amount > 0 && !inv.paused;
  /** Where "Back to …" goes: ?return= when it is on the host's own site (no open redirect), else the host's billing page. */
  function returnOf(req, inv) {
    const asked = typeof req.query.return === 'string' ? req.query.return : '';
    const site = S.options.publicUrl ? new URL(S.options.publicUrl).origin : `${req.protocol}://${req.get('host')}`;
    if (asked) {
      if (/^\/(?![/\\])/.test(asked)) return `${site}${asked}`;
      try {
        if (new URL(asked).origin === site) return asked;
      } catch { /* not a URL */ }
    }
    try {
      return S.options.billingUrl?.(S.repos.accounts.get(inv.accountId)) ?? null;
    } catch {
      return null;
    }
  }
  router.get('/invoices/:token', wrap(async (req, res) => {
    const inv = invoiceOf(req.params.token);
    const { label: providerLabel, mode } = await providerOf();
    const pdfHref = `${encodeURIComponent(req.params.token)}/pdf`;
    const returnUrl = returnOf(req, inv);
    if (inv.status === 'paid') {
      const payment = S.repos.payments.list((p) => p.invoiceId === inv.id && p.status === 'succeeded').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
      const card = payment?.methodId ? S.repos.methods.get(payment.methodId)?.display ?? null : null;
      return res.type('html').send(successHtml(inv, { brand, mode, providerLabel, payment, card, pdfHref, returnUrl: req.query.return ? returnUrl : null }));
    }
    if (!payable(inv)) return res.type('html').send(closedHtml(inv, { brand, mode, pdfHref, returnUrl }));
    const waiting = S.repos.payments.list((p) => p.invoiceId === inv.id && p.status === 'requires_action').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    const notice = waiting ? 'Your bank asks you to confirm the last payment.' : (inv.attempts ?? 0) > 0 ? `The last attempt to charge the card failed${inv.nextAttemptAt ? `; we try again on ${inv.nextAttemptAt.slice(0, 10)}` : ''}. Pay it now with another card.` : null;
    res.type('html').send(checkoutHtml(inv, { brand, mode, providerLabel, token: req.params.token, pdfHref, returnUrl, notice, actionHref: waiting ? `../actions/${P.tokens.action(waiting.id)}` : null }));
  }));
  // Paying from the checkout: a card setup for the invoice's account, then the card it took pays the invoice.
  router.post('/invoices/:token/setup', wrap(async (req, res) => {
    const inv = invoiceOf(req.params.token);
    if (!payable(inv)) throw new PayError(409, 'conflict', 'There is nothing left to pay on this invoice.');
    res.status(201).json(await P.setupMethod(inv.accountId));
  }));
  router.post('/invoices/:token/pay', express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const inv = invoiceOf(req.params.token);
    const save = req.body?.save !== false;
    const card = await P.confirmMethod(inv.accountId, String(req.body?.setupId ?? ''), { makeDefault: save });
    // A new default card retries what is overdue by itself (payments/service.js retryOverdue): wait for that, and read
    // its payment rather than charging the card a second time.
    const overdue = (inv.status === 'open' && (inv.attempts ?? 0) > 0) || inv.status === 'uncollectible';
    const retried = overdue && S.repos.accounts.get(inv.accountId)?.defaultMethodId === card.id;
    await S.work.idle();
    let now = S.repos.invoices.get(inv.id);
    let payment = retried ? S.repos.payments.list((p) => p.invoiceId === inv.id && p.methodId === card.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null : null;
    if (!retried && payable(now)) {
      try {
        ({ payment } = await P.collect(inv.id, { methodId: card.id }));
      } catch (err) {
        if (err.status !== 409) throw err;
      }
      await S.work.idle();
      now = S.repos.invoices.get(inv.id);
    }
    if (!save && payment?.status !== 'requires_action') await P.removeMethod(inv.accountId, card.id).catch(() => {});
    if (now.status === 'paid') return res.json({ status: 'paid' });
    if (payment?.status === 'requires_action') return res.json({ status: 'requires_action', actionUrl: P.actionUrl(payment.id) });
    res.json({ status: 'failed', message: payment?.failure?.message ?? now.lastFailure?.message ?? 'The card was not charged.' });
  }));
  router.get('/invoices/:token/pdf', wrap(async (req, res) => {
    const inv = invoiceOf(req.params.token);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${inv.number}.pdf"`).send(invoicePdf(inv, { brand }));
  }));

  router.get('/actions/:token', wrap(async (req, res) => {
    const { payment, invoice, clientSecret, client } = await P.actionFor(req.params.token);
    const amount = format(payment.amount);
    const what = invoice ? `invoice ${esc(invoice.number)}` : 'this payment';
    let body;
    if (payment.status === 'succeeded') body = `<h1>Payment confirmed</h1><p class="pay-status pay-status-paid">Paid</p><p>${esc(amount)} for ${what} is paid. You can close this page.</p>`;
    else if (payment.status === 'failed') body = `<h1>Payment not confirmed</h1><p class="pay-status pay-status-uncollectible">Failed</p><p>${esc(amount)} for ${what} was not paid${payment.failure?.message ? `: ${esc(payment.failure.message)}` : '.'}</p>`;
    else if (payment.status !== 'requires_action') body = `<h1>Payment in progress</h1><p>${esc(amount)} for ${what} is being processed.</p>`;
    else if (client.provider === 'mock') {
      body = `<h1>Confirm your payment</h1><p>Your bank asks you to confirm ${esc(amount)} for ${what}.</p>
<p class="pay-muted">Test bank page (mock provider).</p>
<form method="post" action="${esc(req.params.token)}/complete" class="pay-co-actions"><button class="pay-co-submit" name="result" value="succeed" type="submit">Confirm the payment</button> <button class="pay-co-secondary" name="result" value="fail" type="submit">Decline</button></form>`;
    } else {
      body = `<h1>Confirm your payment</h1><p>Your bank asks you to confirm ${esc(amount)} for ${what}.</p>
<div id="pay-action" data-publishable-key="${esc(client.publishableKey ?? '')}" data-client-secret="${esc(clientSecret ?? '')}" data-complete="${esc(req.params.token)}/complete"><p class="pay-muted" role="status">Opening your bank's check…</p></div>`;
    }
    const scripts = payment.status === 'requires_action' && client.provider === 'stripe' ? ['https://js.stripe.com/v3/', '../assets/action.js'] : [];
    const { mode } = await providerOf();
    res.type('html').send(publicPage('Confirm your payment', `<section class="pay-co-card pay-co-success">${body}</section>`, { brand, mode, scripts: scripts.map((src) => ({ src, classic: true })) }));
  }));
  router.post('/actions/:token/complete', express.urlencoded({ extended: false, limit: '4kb' }), wrap(async (req, res) => {
    await P.completeAction(req.params.token, { succeed: req.body?.result !== 'fail' });
    res.redirect(303, `../${encodeURIComponent(req.params.token)}`);
  }));

  if (S.provider.name === 'mock') {
    router.get('/mock/fields', (req, res) => {
      res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Card details</title><link rel="stylesheet" href="../assets/styles.css"><link rel="stylesheet" href="../assets/invoice.css"></head>
<body class="pay-fields"><form id="pay-fields" novalidate>
<label for="pay-number">Card number</label><input id="pay-number" name="number" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" maxlength="23" required>
<div class="pay-row"><div><label for="pay-exp">Expiry (MM/YY)</label><input id="pay-exp" name="exp" inputmode="numeric" autocomplete="cc-exp" placeholder="12/30" maxlength="5" required></div>
<div><label for="pay-cvc">Security code</label><input id="pay-cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" required></div></div>
<p id="pay-error" class="pay-error" role="alert"></p>
<p class="pay-muted">Test mode. 4242 4242 4242 4242 pays; 4000 0000 0000 0341 is saved, then declined; 4000 0027 6000 3184 asks for 3-D Secure.</p>
</form><script src="../assets/fields.js"></script></body></html>`);
    });
    router.post('/mock/setups', express.json({ limit: '2kb' }), wrap(async (req, res) => {
      const { secret, number, exp, cvc } = req.body ?? {};
      const [mm, yy] = String(exp ?? '').split('/');
      try {
        const display = S.provider.hostedFields.attach(String(secret ?? ''), { number, expMonth: mm, expYear: yy, cvc });
        res.json({ ok: true, display });
      } catch (err) {
        if (err instanceof ProviderError) return res.status(402).json({ error: { code: err.code, message: err.message, details: [] } });
        throw err;
      }
    }));
  }

  router.use(errorHandler(S.log));
  return router;
}
