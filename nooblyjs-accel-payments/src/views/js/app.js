// NooblyJS Pay, the payments operator UI (spec §9; the mock-ups in .claude/steering/ui): Orders & payments (an invoice
// is the order), Refund a payment, Recurring (subscriptions), Checkout page, and the books (Overview, Accounts, Plans,
// Reconciliation) and Setup (the provider connection, webhooks). A hash router over the module APIs; no inline handlers
// (core's CSP): clicks, inputs and forms are delegated by data-action.
import { formatMoney } from '../components/billing-summary.js';

const BASE = location.pathname.replace(/\/payments\/?(index\.html)?$/, '');
const PAY = `${BASE}/payments/api/v1`;
const BILL = `${BASE}/billing/api/v1`;
const main = document.getElementById('pay-main');
document.getElementById('pay-api-link').href = `${PAY}/openapi.json`;

// ---- helpers --------------------------------------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const raw = (s) => ({ __html: String(s) });
const render = (v) => (v === undefined || v === null || v === false ? '' : Array.isArray(v) ? v.map(render).join('') : typeof v === 'object' && '__html' in v ? v.__html : esc(v));
const h = (strings, ...values) => raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
const mount = (tpl) => { main.innerHTML = render(tpl); };
const money = (m) => (m ? formatMoney(m) : '—');
const usd = (amount, currency = 'USD') => formatMoney({ amount, currency });
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const time = (iso) => (iso ? new Date(iso).toISOString().slice(11, 16) + ' UTC' : '');
const when = (iso) => (iso ? `${day(iso)} · ${time(iso)}` : '—');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('noobly.csrf='))?.split('=')[1];
const EXP = { JPY: 0, KRW: 0 };
const toMinor = (text, currency = 'USD') => {
  const exp = EXP[currency] ?? 2;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(text ?? '').trim().replace(/^\$/, ''));
  if (!m || (m[2] ?? '').length > exp) return null;
  return Number(m[1]) * 10 ** exp + Number(((m[2] ?? '') + '0'.repeat(exp)).slice(0, exp) || 0);
};
const fromMinor = (n, currency = 'USD') => { const exp = EXP[currency] ?? 2; return exp ? (n / 10 ** exp).toFixed(exp) : String(n); };
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', diners: 'Diners', jcb: 'JCB', unionpay: 'UnionPay' };
const cardText = (d) => (d ? `${BRANDS[d.brand] ?? d.brand} ·· ${d.last4}` : 'Card');
const WORDS = {
  succeeded: 'Succeeded', partially_refunded: 'Partially refunded', refunded: 'Refunded', failed: 'Failed', processing: 'Processing',
  requires_action: 'Needs 3-D Secure', paid: 'Paid', open: 'Open', overdue: 'Overdue', uncollectible: 'Written off', void: 'Void', draft: 'Draft',
  active: 'Active', paused: 'Paused', past_due: 'Past due', cancelled: 'Cancelled', trialing: 'Trial', delinquent: 'Delinquent', closed: 'Closed',
  resolved: 'Resolved', pending: 'Pending', inactive: 'Off', test: 'Test mode', live: 'Live mode',
};
const pill = (s, label) => h`<span class="pay-status pay-status-${s}">${label ?? WORDS[s] ?? String(s).replace(/_/g, ' ')}</span>`;
const REASONS = [['requested_by_customer', 'Requested by customer'], ['duplicate', 'Duplicate payment'], ['fraudulent', 'Fraudulent'], ['other', 'Other']];

/** A payment's state with its refunds in it. */
const payState = (p) => (p.status !== 'succeeded' ? p.status : (p.refunded?.amount ?? 0) >= p.amount.amount ? 'refunded' : (p.refunded?.amount ?? 0) > 0 ? 'partially_refunded' : 'succeeded');
/** An invoice's state as an order: overdue while retrying, refunded when its money went back. */
const orderState = (i, refunded = 0) => (i.status === 'open' && i.attempts ? 'overdue' : i.status === 'paid' && refunded > 0 ? (refunded >= i.amountPaid.amount ? 'refunded' : 'partially_refunded') : i.status);

async function api(url, { method = 'GET', body, idempotent = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf()) headers['x-csrf-token'] = csrf();
  if (idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `The request failed (${res.status}).`);
    err.details = json?.error?.details ?? [];
    throw err;
  }
  return json;
}

function toast(message, error = false) {
  const box = document.getElementById('pay-toasts');
  const t = document.createElement('div');
  t.className = `pay-toast${error ? ' pay-toast-error' : ''}`;
  t.setAttribute('role', error ? 'alert' : 'status');
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

let provider = null;
const providerInfo = async () => (provider ??= await api(`${PAY}/provider`).catch(() => ({ name: 'mock', label: 'Payment provider', mode: 'test', account: null, brand: '' })));
const isStripe = () => provider?.name === 'stripe';
const providerWord = () => (isStripe() ? 'Stripe' : provider?.label ?? 'the provider');
const stripeLink = (ref) => (provider?.dashboard && ref ? `${provider.dashboard}/payments/${encodeURIComponent(ref)}` : null);

const header = (title, subtitle, { eyebrow = null, actions = null } = {}) => h`<header class="pay-page-header"><div>
  ${eyebrow ? (eyebrow.href ? h`<a class="pay-eyebrow" href="${eyebrow.href}"><i class="bi bi-arrow-left" aria-hidden="true"></i>${eyebrow.text}</a>` : h`<p class="pay-eyebrow pay-eyebrow-plain">${eyebrow.text}</p>`) : ''}
  <h1 class="pay-page-title">${title}</h1>${subtitle ? h`<p class="pay-page-subtitle">${subtitle}</p>` : ''}</div>
  ${actions ? h`<div class="pay-page-actions">${actions}</div>` : ''}</header>`;
const table = (cols, rows, empty, caption = '') => (rows.length
  ? h`<div class="pay-table-wrap"><table class="pay-table">${caption ? h`<caption class="visually-hidden">${caption}</caption>` : ''}<thead><tr>${cols.map((c) => h`<th scope="col" class="${c.num ? 'pay-num' : ''}">${c.label}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`
  : h`<p class="pay-empty">${empty}</p>`);
const stat = (label, value, { sub = '', tone = '' } = {}) => h`<div class="pay-stat"><div class="pay-stat-label">${label}</div><div class="pay-stat-value ${tone ? `pay-${tone}` : ''}">${value}</div>${sub ? h`<div class="pay-stat-sub">${sub}</div>` : ''}</div>`;
const card = (title, body, { sub = '', id = '', actions = null } = {}) => h`<section class="pay-card" ${id ? raw(`aria-labelledby="${esc(id)}"`) : ''}>
  <div class="pay-card-head"><div><h2 class="pay-card-title" ${id ? raw(`id="${esc(id)}"`) : ''}>${title}</h2>${sub ? h`<p class="pay-card-sub">${sub}</p>` : ''}</div>${actions ?? ''}</div>${body}</section>`;
/** Filter chips as links (the hash keeps the filter, so back works). */
const chips = (label, items, current, hrefOf) => h`<div class="pay-chips" role="group" aria-label="${label}">${items.map(([key, text, count]) => h`<a class="pay-chip" href="${hrefOf(key)}" ${key === current ? raw('aria-current="true"') : ''}>${text}${count !== undefined ? h`<span class="pay-chip-count">${count}</span>` : ''}</a>`)}</div>`;
const searchBox = (action, value, label, placeholder) => h`<form class="pay-search" data-action="${action}" role="search"><i class="bi bi-search" aria-hidden="true"></i><input class="form-control" name="q" type="search" value="${value}" aria-label="${label}" placeholder="${placeholder}"></form>`;
const hashOf = (path, params) => { const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString(); return `#${path}${q ? `?${q}` : ''}`; };
const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);

// ---- Orders & payments ----------------------------------------------------------------------------------------------

function takePaymentForm(accounts) {
  return card('Take a payment', h`<form data-action="take-payment" novalidate>
    <div class="pay-form-grid">
      <div class="pay-field"><label class="form-label" for="tp-account">Customer</label>
        <select class="form-select" id="tp-account" name="accountId" required>${accounts.map((a) => h`<option value="${a.id}">${a.name} · ${a.email}</option>`)}</select></div>
      <div class="pay-field"><label class="form-label" for="tp-what">What it is for</label>
        <input class="form-control" id="tp-what" name="description" required maxlength="300" placeholder="e.g. Set-up and migration"></div>
      <div class="pay-field"><label class="form-label" for="tp-amount">Amount (USD)</label>
        <div class="input-group"><span class="input-group-text">$</span><input class="form-control" id="tp-amount" name="amount" inputmode="decimal" required aria-describedby="tp-amount-error"></div>
        <div class="invalid-feedback d-block" id="tp-amount-error" data-error="amount"></div></div>
    </div>
    <fieldset class="pay-field"><legend class="form-label">How to collect it</legend>
      <div class="pay-choice-grid">
        <label class="pay-choice"><input type="radio" name="collect" value="card" checked><span><strong>Charge the card on file</strong><span>Now, with the customer's default card. A failure is retried on the dunning schedule.</span></span></label>
        <label class="pay-choice"><input type="radio" name="collect" value="link"><span><strong>Email a payment link</strong><span>The customer pays on the hosted checkout page and can save the card.</span></span></label>
      </div></fieldset>
    <div class="pay-form-foot"><button class="pay-btn pay-btn-primary" type="submit">Create the order</button><button class="pay-btn" type="button" data-action="hide-take">Cancel</button></div>
  </form>`, { id: 'take-title', sub: 'A one-off invoice for any account, numbered like every other.' });
}

const views = {
  async orders(params) {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const show = params.get('show') ?? 'all';
    const [{ items: invoices }, { items: payments }, o] = await Promise.all([
      api(`${BILL}/invoices?limit=500&sort=-createdAt`), api(`${PAY}/payments?limit=500&sort=-createdAt`), api(`${PAY}/overview`),
    ]);
    const refundedOf = new Map();
    const collectedOf = new Map();
    for (const p of payments) {
      if (p.status !== 'succeeded' || !p.invoiceId) continue;
      collectedOf.set(p.invoiceId, (collectedOf.get(p.invoiceId) ?? 0) + p.amount.amount);
      refundedOf.set(p.invoiceId, (refundedOf.get(p.invoiceId) ?? 0) + (p.refunded?.amount ?? 0));
    }
    const rows = invoices.filter((i) => i.status !== 'draft' || show === 'all').map((i) => ({ i, state: orderState(i, refundedOf.get(i.id) ?? 0) }));
    const groups = { all: () => true, open: (r) => r.state === 'open', overdue: (r) => r.state === 'overdue' || r.state === 'uncollectible', paid: (r) => r.state === 'paid', refunded: (r) => r.state === 'refunded' || r.state === 'partially_refunded' };
    const matches = (r) => !q || `${r.i.number ?? ''} ${r.i.billingDetails?.name ?? ''} ${r.i.billingDetails?.email ?? ''}`.toLowerCase().includes(q);
    const shown = rows.filter((r) => (groups[show] ?? groups.all)(r) && matches(r));
    const take = params.get('take') === '1';
    const accounts = take ? (await api(`${PAY}/accounts?limit=500&sort=name`)).items.filter((a) => a.status !== 'closed') : [];
    mount(h`${header('Orders & payments', 'Every invoice is an order: what it was for, what was collected, what went back.', {
      actions: h`<a class="pay-btn pay-btn-primary" href="${hashOf('/orders', { take: '1' })}"><i class="bi bi-plus-lg" aria-hidden="true"></i>Take a payment</a>`,
    })}
      ${take ? takePaymentForm(accounts) : ''}
      <div class="pay-stats">
        ${stat('Collected this month', money(o.revenueThisMonth), { tone: 'teal' })}
        ${stat('Open', money(o.open.amount), { sub: plural(o.open.count, 'order') })}
        ${stat('Overdue', money(o.overdue.amount), { sub: `${o.overdue.count} retrying`, tone: o.overdue.count ? 'danger' : '' })}
        ${stat('Failed payments', String(o.failedPayments30d), { sub: 'Last 30 days' })}
      </div>
      ${card('Orders', h`<div class="pay-toolbar">${searchBox('order-list-search', q, 'Search orders', 'Search order, name or email')}
        ${chips('Show', [['all', 'All', rows.length], ['open', 'Open', rows.filter(groups.open).length], ['overdue', 'Overdue', rows.filter(groups.overdue).length], ['paid', 'Paid', rows.filter(groups.paid).length], ['refunded', 'Refunded', rows.filter(groups.refunded).length]], show, (k) => hashOf('/orders', { show: k === 'all' ? '' : k, q }))}</div>
        ${table([{ label: 'Order' }, { label: 'Date' }, { label: 'Total', num: true }, { label: 'Collected', num: true }, { label: 'Refunded', num: true }, { label: 'Status' }],
          shown.map(({ i, state }) => h`<tr>
            <td><a class="pay-strong" href="#/orders/${encodeURIComponent(i.id)}">${i.number ?? 'Draft'}</a><span class="pay-sub">${i.billingDetails?.name ?? ''}</span></td>
            <td>${day(i.finalizedAt ?? i.createdAt)}</td><td class="pay-num">${money(i.total)}</td>
            <td class="pay-num">${collectedOf.get(i.id) ? usd(collectedOf.get(i.id), i.currency) : '—'}</td>
            <td class="pay-num">${refundedOf.get(i.id) ? `−${usd(refundedOf.get(i.id), i.currency)}` : '—'}</td><td>${pill(state)}</td></tr>`),
          q || show !== 'all' ? 'No orders match.' : 'No orders yet.', 'Orders')}`, { id: 'orders-title' })}`);
    if (take) main.querySelector('#tp-account')?.focus();
  },

  async order(params, id) {
    const [inv] = await Promise.all([api(`${BILL}/invoices/${encodeURIComponent(id)}`), providerInfo()]);
    const pays = [...inv.payments].sort(byNewest);
    const ok = pays.filter((p) => p.status === 'succeeded');
    const collected = sum(ok, (p) => p.amount.amount);
    const refunded = sum(ok, (p) => p.refunded?.amount);
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const show = params.get('show') ?? 'all';
    const selected = pays.find((p) => p.id === params.get('payment')) ?? ok[0] ?? pays[0] ?? null;
    const counts = { all: pays.length };
    for (const p of pays) counts[payState(p)] = (counts[payState(p)] ?? 0) + 1;
    const shown = pays.filter((p) => (show === 'all' || payState(p) === show) && (!q || `${p.id} ${p.providerRef ?? ''} ${cardText(p.method)}`.toLowerCase().includes(q)));
    const link = (extra) => hashOf(`/orders/${id}`, { show: show === 'all' ? '' : show, q, payment: selected?.id, ...extra });
    const b = inv.billingDetails ?? {};
    const payable = ['open', 'uncollectible'].includes(inv.status);
    const actions = h`
      ${inv.url ? h`<button type="button" class="pay-btn" data-action="copy" data-text="${inv.url}"><i class="bi bi-link-45deg" aria-hidden="true"></i>Copy payment link</button>` : ''}
      ${payable ? h`<button type="button" class="pay-btn pay-btn-primary" data-action="invoice" data-op="pay" data-id="${inv.id}"><i class="bi bi-credit-card" aria-hidden="true"></i>Take a payment</button>` : ''}
      ${inv.status === 'draft' ? h`<button type="button" class="pay-btn pay-btn-primary" data-action="invoice" data-op="finalize" data-id="${inv.id}">Finalise</button>` : ''}`;
    mount(h`${header('Order payments', `Placed ${day(inv.finalizedAt ?? inv.createdAt)} · ${b.name ?? ''} · ${b.email ?? ''}`, { eyebrow: { href: '#/orders', text: `Orders · ${inv.number ?? 'Draft'}` }, actions })}
      <div class="pay-stats">
        ${stat('Order total', money(inv.total), { sub: h`${pill(orderState(inv, refunded))}` })}
        ${stat(`Collected · ${plural(ok.length, 'payment')}`, usd(collected, inv.currency), { tone: 'teal' })}
        ${stat('Refunded', refunded ? `−${usd(refunded, inv.currency)}` : usd(0, inv.currency))}
        ${stat('Net received', usd(collected - refunded, inv.currency), { sub: payable ? `${money(inv.amountRemaining)} left to pay` : '' })}
      </div>
      <div class="pay-grid">
        <div class="pay-col">
          ${card('Payments for this order', h`<div class="pay-toolbar">${searchBox('order-search', q, 'Search payments', 'Search payment, charge or card')}
            ${chips('Show', [['all', 'All', counts.all], ['succeeded', 'Succeeded', counts.succeeded ?? 0], ['partially_refunded', 'Partially refunded', counts.partially_refunded ?? 0], ['refunded', 'Refunded', counts.refunded ?? 0], ['failed', 'Failed', counts.failed ?? 0]], show, (k) => link({ show: k === 'all' ? '' : k }))}</div>
            ${table([{ label: 'Date' }, { label: 'Payment' }, { label: 'Method' }, { label: 'Amount', num: true }, { label: 'Refunded', num: true }, { label: 'Status' }, { label: 'Actions', num: true }],
              shown.map((p) => h`<tr class="${p.id === selected?.id ? 'pay-selected' : ''}">
                <td>${day(p.createdAt)}<span class="pay-sub">${time(p.createdAt)}</span></td>
                <td><a class="pay-mono" href="${link({ payment: p.id })}" aria-label="Details of ${p.id}">${p.id}</a>${p.providerRef ? h`<span class="pay-sub pay-mono">${p.providerRef}</span>` : ''}</td>
                <td>${cardText(p.method)}</td><td class="pay-num pay-strong">${money(p.amount)}</td>
                <td class="pay-num">${p.refunded?.amount ? `−${money(p.refunded)}` : '—'}</td><td>${pill(payState(p))}</td>
                <td class="pay-num">${p.status === 'succeeded' && (p.refunded?.amount ?? 0) < p.amount.amount ? h`<a class="pay-btn pay-btn-sm" href="#/refund/${encodeURIComponent(p.id)}" aria-label="Refund ${p.id}">Refund</a>` : ''}</td></tr>`),
              pays.length ? 'No payments match.' : payable ? 'No payment yet. Take a payment, or copy the payment link and send it.' : 'No payments.', 'Payments for this order')}
            <p class="pay-note">Only succeeded charges can be refunded. Failed attempts stay listed for the record.</p>`, { id: 'payments-title' })}
          ${orderLines(inv)}
        </div>
        <aside class="pay-col pay-panel" aria-label="Payment details">${selected ? paymentPanel(selected, inv) : card('Payment details', h`<p class="pay-empty">No payment to show.</p>`)}</aside>
      </div>`);
  },

  async refund(params, id) {
    const [p] = await Promise.all([api(`${PAY}/payments/${encodeURIComponent(id)}`), providerInfo()]);
    const inv = p.invoiceId ? await api(`${BILL}/invoices/${encodeURIComponent(p.invoiceId)}`) : null;
    const cur = p.amount.currency;
    const before = p.refunded?.amount ?? 0;
    const left = p.amount.amount - before;
    const done = params.get('done') ? p.refunds.find((r) => r.id === params.get('done')) : null;
    const back = inv ? { href: `#/orders/${encodeURIComponent(inv.id)}?payment=${encodeURIComponent(p.id)}`, text: `Back to ${inv.number}` } : { href: '#/refunds', text: 'Back to refunds' };
    const email = inv?.billingDetails?.email ?? '';
    const earlier = [...p.refunds].sort(byNewest);
    const form = left > 0 && p.status === 'succeeded' ? card('How much to refund', h`<form data-action="refund" data-id="${p.id}" data-currency="${cur}" data-left="${left}" data-before="${before}" data-original="${p.amount.amount}" novalidate>
        <fieldset><legend class="visually-hidden">How much</legend><div class="pay-choice-grid">
          <label class="pay-choice"><input type="radio" name="how" value="all" checked><span><strong>Everything that's left</strong><span>${usd(left, cur)} of ${money(p.amount)}</span></span></label>
          <label class="pay-choice"><input type="radio" name="how" value="part"><span><strong>A partial amount</strong><span>For one item, shipping or a goodwill credit</span></span></label>
        </div></fieldset>
        <div class="pay-field"><label class="form-label" for="rf-amount">Refund amount (${cur})</label>
          <div class="input-group pay-amount-group"><span class="input-group-text">$</span><input class="form-control" id="rf-amount" name="amount" inputmode="decimal" value="${fromMinor(left, cur)}" readonly aria-describedby="rf-amount-error"></div>
          <div class="invalid-feedback d-block" id="rf-amount-error" data-error="amount"></div></div>
        <div class="pay-field"><label class="form-label" for="rf-reason">Reason</label>
          <select class="form-select" id="rf-reason" name="reasonCode" aria-describedby="rf-reason-hint">${REASONS.map(([v, l]) => h`<option value="${v}">${l}</option>`)}</select>
          <div class="form-text" id="rf-reason-hint">${isStripe() ? 'Sent to Stripe as the refund reason. Fraudulent also tells Stripe to block the card in Radar.' : `Kept with the refund and sent to ${providerWord()}.`}</div></div>
        <div class="pay-field"><label class="form-label" for="rf-note">Note for your team <span class="pay-sub d-inline">(optional)</span></label>
          <textarea class="form-control" id="rf-note" name="note" rows="3" maxlength="480" placeholder="e.g. One item arrived damaged, customer keeping the rest"></textarea></div>
        ${email ? h`<div class="form-check"><input class="form-check-input" type="checkbox" id="rf-notify" name="notify" checked><label class="form-check-label" for="rf-notify">Email ${email} a refund receipt</label></div>` : ''}
        <div class="pay-form-foot"><button class="pay-btn pay-btn-primary" type="submit" data-refund-submit>Refund ${usd(left, cur)}</button><a class="pay-btn" href="${back.href}">Cancel</a></div>
      </form>`, { id: 'refund-how' }) : card('Nothing left to refund', h`<p class="pay-card-sub">${p.status === 'succeeded' ? `All of ${money(p.amount)} has gone back to the card.` : `This payment ${WORDS[p.status]?.toLowerCase() ?? p.status}: only a succeeded payment can be refunded.`}</p>`);
    mount(h`${header('Refund a payment', h`${cardText(p.method)} · paid ${day(p.createdAt)}${p.providerRef ? h` · <span class="pay-mono">${p.providerRef}</span>` : ''}`, { eyebrow: back })}
      ${done ? h`<div class="pay-alert pay-alert-ok" role="status"><i class="bi bi-check-circle" aria-hidden="true"></i><div><strong>Refund of ${money(done.amount)} sent to ${providerWord()}.</strong> It is ${(WORDS[done.status] ?? done.status).toLowerCase()}; banks usually take 5–10 business days to show it on the card.</div></div>` : ''}
      <div class="pay-grid">
        <div class="pay-col">${form}</div>
        <aside class="pay-col" aria-label="Summary">
          ${card('Summary', h`<div data-refund-summary>
            <div class="pay-sum-row"><span>Original payment</span><span class="pay-num">${money(p.amount)}</span></div>
            <div class="pay-sum-row"><span>Already refunded</span><span class="pay-num">${before ? `−${usd(before, cur)}` : usd(0, cur)}</span></div>
            ${left > 0 ? h`<div class="pay-sum-row pay-sum-this"><span>This refund</span><span class="pay-num" data-sum="this">−${usd(left, cur)}</span></div>` : ''}
            <div class="pay-sum-total"><span>You keep</span><span class="pay-num" data-sum="keep">${usd(left > 0 ? 0 : p.amount.amount - before, cur)}</span></div></div>
            <p class="pay-hint"><i class="bi bi-info-circle" aria-hidden="true"></i><span>${isStripe() ? h`Stripe does not return its processing fee on refunds. Your app gets a <code>refund.created</code> webhook when it settles.` : 'The processing fee is not returned on refunds. The mock provider settles a refund at once.'}</span></p>`, { id: 'refund-summary' })}
          ${card('Earlier refunds', earlier.length ? h`<ul class="pay-list">${earlier.map((r) => h`<li><div><span class="pay-strong">${money(r.amount)}</span><span class="pay-sub">${day(r.createdAt)} · ${REASONS.find(([v]) => v === r.reasonCode)?.[1] ?? 'Other'} · ${r.by?.name ?? r.by?.id ?? r.source}</span>${r.reason ? h`<span class="pay-sub">${r.reason}</span>` : ''}<span class="pay-sub pay-mono">${r.providerRef}</span></div>${pill(r.status)}</li>`)}</ul>` : h`<p class="pay-card-sub">None yet.</p>`, { id: 'refund-earlier' })}
        </aside>
      </div>`);
  },

  async refunds(params) {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const [{ items }, { items: invoices }, { items: accounts }] = await Promise.all([api(`${PAY}/refunds?limit=500&sort=-createdAt`), api(`${BILL}/invoices?limit=500`), api(`${PAY}/accounts?limit=500`)]);
    const invoiceOf = new Map(invoices.map((i) => [i.id, i]));
    const accountOf = new Map(accounts.map((a) => [a.id, a]));
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = items.filter((r) => r.createdAt?.startsWith(month));
    const shown = items.filter((r) => !q || `${invoiceOf.get(r.invoiceId)?.number ?? ''} ${accountOf.get(r.accountId)?.name ?? ''} ${r.reason}`.toLowerCase().includes(q));
    mount(h`${header('Refunds', `Refunds made here and on ${isStripe() ? 'the Stripe dashboard' : 'the provider'}. To refund, open an order and choose Refund on a payment.`)}
      <div class="pay-stats">
        ${stat('Refunded this month', usd(sum(thisMonth, (r) => r.amount.amount)), { sub: plural(thisMonth.length, 'refund') })}
        ${stat('All refunds', String(items.length))}
        ${stat('Pending', String(items.filter((r) => r.status === 'pending').length), { sub: 'Waiting on the bank' })}
      </div>
      ${card('Refunds', h`<div class="pay-toolbar">${searchBox('refund-search', q, 'Search refunds', 'Search order, customer or reason')}</div>
        ${table([{ label: 'Date' }, { label: 'Order' }, { label: 'Customer' }, { label: 'Reason' }, { label: 'By' }, { label: 'Status' }, { label: 'Amount', num: true }],
          shown.map((r) => h`<tr><td>${day(r.createdAt)}<span class="pay-sub">${time(r.createdAt)}</span></td>
            <td>${r.invoiceId && invoiceOf.get(r.invoiceId) ? h`<a href="#/orders/${encodeURIComponent(r.invoiceId)}?payment=${encodeURIComponent(r.paymentId)}">${invoiceOf.get(r.invoiceId).number}</a>` : h`<span class="pay-mono">${r.paymentId}</span>`}</td>
            <td>${accountOf.get(r.accountId)?.name ?? '—'}</td>
            <td class="pay-wrap">${REASONS.find(([v]) => v === r.reasonCode)?.[1] ?? 'Other'}<span class="pay-sub">${r.reason}</span></td>
            <td>${r.by?.name ?? r.by?.id ?? r.source}</td><td>${pill(r.status)}</td><td class="pay-num pay-strong">−${money(r.amount)}</td></tr>`),
          q ? 'No refunds match.' : 'No refunds yet.', 'Refunds')}`, { id: 'refunds-title' })}`);
  },

  // ---- Recurring ----------------------------------------------------------------------------------------------------

  async recurring(params) {
    const show = params.get('show') ?? 'all';
    const [{ items: subs }, { items: accounts }, { items: open }, { items: prices }, { items: products }] = await Promise.all([
      api(`${BILL}/subscriptions?limit=500&sort=-createdAt`), api(`${PAY}/accounts?limit=500&sort=name`),
      api(`${BILL}/invoices?limit=500&filter[status]=open`), api(`${BILL}/prices?limit=500`), api(`${BILL}/products?limit=500`),
    ]);
    const accountOf = new Map(accounts.map((a) => [a.id, a]));
    const priceOf = new Map(prices.map((p) => [p.id, p]));
    const live = subs.filter((s) => s.status !== 'cancelled').slice(0, 100);
    const cardsOf = new Map(await Promise.all([...new Set(live.map((s) => s.accountId))].map(async (id) => [id, (await api(`${PAY}/accounts/${id}/methods`).catch(() => ({ items: [] }))).items])));
    const previews = new Map(await Promise.all(live.filter((s) => s.items.some((it) => priceOf.get(it.priceId)?.meterId)).map(async (s) => [s.id, await api(`${BILL}/subscriptions/${s.id}/preview`).catch(() => null)])));
    const rows = subs.map((s) => {
      const account = accountOf.get(s.accountId);
      const overdue = open.filter((i) => i.subscriptionId === s.id && i.attempts > 0).sort((a, b) => (a.nextAttemptAt < b.nextAttemptAt ? -1 : 1))[0] ?? null;
      const state = s.status === 'cancelled' ? 'cancelled' : s.pausedAt ? 'paused' : overdue || account?.status === 'delinquent' ? 'past_due' : s.status;
      const licensed = s.items.map((it) => ({ it, price: priceOf.get(it.priceId) })).filter(({ price }) => price && !price.meterId);
      const metered = s.items.length - licensed.length;
      const each = sum(licensed, ({ it, price }) => (price.unitAmount ?? 0) * it.quantity);
      const def = (cardsOf.get(s.accountId) ?? []).find((m) => m.id === account?.defaultMethodId);
      return { s, account, overdue, state, each, metered, def, preview: previews.get(s.id) };
    });
    const groups = { all: (r) => r.state !== 'cancelled', active: (r) => r.state === 'active' || r.state === 'trialing', paused: (r) => r.state === 'paused', past_due: (r) => r.state === 'past_due', cancelled: (r) => r.state === 'cancelled' };
    const shown = rows.filter(groups[show] ?? groups.all);
    const every = (s) => (s.interval === 'year' ? 'Yearly' : 'Monthly');
    mount(h`${header('Recurring payments', `Charge a saved card on a schedule. Each schedule is a subscription your app can pause, resume or cancel.`)}
      <div class="pay-stats">
        ${stat('Active', String(rows.filter(groups.active).length))}
        ${stat('Paused', String(rows.filter(groups.paused).length))}
        ${stat('Needs attention · past due', String(rows.filter(groups.past_due).length), { tone: rows.some(groups.past_due) ? 'danger' : '' })}
      </div>
      ${card('Schedules', h`<div class="pay-toolbar">${chips('Show', [['all', 'All', rows.filter(groups.all).length], ['active', 'Active', rows.filter(groups.active).length], ['paused', 'Paused', rows.filter(groups.paused).length], ['past_due', 'Past due', rows.filter(groups.past_due).length], ['cancelled', 'Cancelled', rows.filter(groups.cancelled).length]], show, (k) => hashOf('/recurring', { show: k === 'all' ? '' : k }))}</div>
        ${table([{ label: 'Customer' }, { label: 'Amount', num: true }, { label: 'Next charge' }, { label: 'Card' }, { label: 'Status' }, { label: 'Actions', num: true }],
          shown.map(({ s, account, overdue, state, each, metered, def, preview }) => h`<tr>
            <td>${account ? h`<a class="pay-strong" href="#/accounts/${encodeURIComponent(account.id)}">${account.name}</a>` : '—'}<span class="pay-sub pay-mono">${s.id}</span></td>
            <td class="pay-num"><span class="pay-strong">${metered && !each ? (preview ? money(preview.amountDue) : 'By usage') : usd(each, account?.currency)}</span><span class="pay-sub">${metered ? (each ? `${every(s)} + usage` : 'So far this period') : every(s)}</span></td>
            <td>${state === 'paused' ? 'Paused' : state === 'cancelled' ? `Ended ${day(s.endedAt)}` : overdue ? h`Failed ${day(overdue.lastAttemptAt ?? overdue.firstFailedAt)}${overdue.nextAttemptAt ? h` ·<span class="pay-sub">retry ${day(overdue.nextAttemptAt)}</span>` : ''}` : s.cancelAtPeriodEnd ? `Ends ${day(s.currentPeriod.end)}` : day(s.currentPeriod.end)}</td>
            <td>${def ? cardText(def.display) : h`<span class="pay-sub">No card</span>`}</td><td>${pill(state)}</td>
            <td class="pay-num">${state === 'past_due' && overdue ? h`<button type="button" class="pay-btn pay-btn-sm" data-action="invoice" data-op="pay" data-id="${overdue.id}">Retry</button> ` : ''}
              ${state === 'paused' ? h`<button type="button" class="pay-btn pay-btn-sm" data-action="sub" data-op="resume" data-id="${s.id}">Resume</button>` : ''}
              ${state === 'active' || state === 'trialing' || (state === 'past_due' && !s.pausedAt) ? h`<button type="button" class="pay-btn pay-btn-sm" data-action="sub" data-op="pause" data-id="${s.id}">Pause</button>` : ''}
              ${state !== 'cancelled' && !s.cancelAtPeriodEnd ? h` <button type="button" class="pay-btn pay-btn-sm pay-btn-danger" data-action="sub" data-op="cancel" data-id="${s.id}" aria-label="Cancel ${s.id} at the end of the period">Cancel</button>` : ''}</td></tr>`),
          'No schedules here.', 'Schedules')}
        <p class="pay-note">A failed charge is retried on the dunning schedule, and your app gets <code>pay.payment.failed</code> each time; after the last try the account is marked delinquent.</p>`, { id: 'schedules-title' })}
      ${card('New schedule', h`<form data-action="new-schedule" novalidate>
        <div class="pay-field"><label class="form-label" for="ns-account">Customer</label>
          <select class="form-select" id="ns-account" name="accountId" required>${accounts.filter((a) => a.status !== 'closed').map((a) => h`<option value="${a.id}">${a.name} · ${a.email}</option>`)}</select></div>
        <div class="pay-form-grid">
          <div class="pay-field"><label class="form-label" for="ns-what">What it is for</label><input class="form-control" id="ns-what" name="description" required maxlength="120" placeholder="e.g. Support plan" aria-describedby="ns-what-error"><div class="invalid-feedback d-block" id="ns-what-error" data-error="description"></div></div>
          <div class="pay-field"><label class="form-label" for="ns-amount">Amount each time</label>
            <div class="input-group"><span class="input-group-text">$</span><input class="form-control" id="ns-amount" name="amount" inputmode="decimal" required aria-describedby="ns-amount-error"><span class="input-group-text">USD</span></div>
            <div class="invalid-feedback d-block" id="ns-amount-error" data-error="amount"></div></div>
        </div>
        <fieldset class="pay-field"><legend class="form-label">Repeats</legend>
          <div class="pay-segmented"><input type="radio" id="ns-month" name="interval" value="month" checked><label for="ns-month">Monthly</label><input type="radio" id="ns-year" name="interval" value="year"><label for="ns-year">Yearly</label></div></fieldset>
        <div class="pay-field"><label class="form-label" for="ns-anchor">Billing day</label>
          <select class="form-select" id="ns-anchor" name="anchor" aria-describedby="ns-anchor-hint"><option value="creation">Today's date, every time</option><option value="calendar">The 1st (the first charge is for the days to the 1st)</option></select>
          <div class="form-text" id="ns-anchor-hint">The first charge is today, to the customer's default card. Without a card, they are emailed a link to pay.</div></div>
        <div class="pay-field"><span class="form-label d-block" id="ns-preview-label">Next charges</span><ul class="pay-preview" aria-labelledby="ns-preview-label" data-schedule-preview></ul></div>
        <div class="pay-form-foot"><button class="pay-btn pay-btn-primary" type="submit">Create schedule</button></div>
      </form>`, { id: 'new-schedule-title', sub: 'A product, a price and a subscription in one step.' })}`);
    schedulePreview(main.querySelector('form[data-action="new-schedule"]'));
  },

  // ---- Checkout page ------------------------------------------------------------------------------------------------

  async checkout() {
    const [{ items: open }, { items: written }] = await Promise.all([api(`${BILL}/invoices?limit=200&filter[status]=open&sort=-createdAt`), api(`${BILL}/invoices?limit=100&filter[status]=uncollectible&sort=-createdAt`), providerInfo()]);
    const list = [...open, ...written];
    const links = await Promise.all(list.slice(0, 50).map((i) => api(`${BILL}/invoices/${i.id}`).then((x) => x.url).catch(() => null)));
    mount(h`${header('Checkout page', `What a customer sees when they open a payment link: the order, the card form, and back to ${provider.brand || 'your app'}.`)}
      <div class="pay-stats">
        ${stat('Brand on the page', provider.brand || '—')}
        ${stat('Mode', h`${pill(provider.mode)}`, { sub: provider.label })}
        ${stat('Waiting to be paid', String(list.length), { sub: money(list.length ? { amount: sum(list, (i) => i.amountRemaining.amount), currency: list[0].currency } : null) })}
      </div>
      <div class="pay-grid">
        <div class="pay-col">${card('Open payment links', table([{ label: 'Order' }, { label: 'Customer' }, { label: 'Due', num: true }, { label: '', num: true }],
          list.slice(0, 50).map((i, n) => h`<tr><td><a class="pay-strong" href="#/orders/${encodeURIComponent(i.id)}">${i.number}</a><span class="pay-sub">${day(i.finalizedAt)}</span></td><td>${i.billingDetails?.name ?? ''}<span class="pay-sub">${i.billingDetails?.email ?? ''}</span></td><td class="pay-num pay-strong">${money(i.amountRemaining)}</td>
            <td class="pay-num">${links[n] ? h`<a class="pay-btn pay-btn-sm" href="${links[n]}" target="_blank" rel="noopener">Open<span class="visually-hidden"> the checkout for ${i.number}</span></a> <button type="button" class="pay-btn pay-btn-sm" data-action="copy" data-text="${links[n]}">Copy link</button>` : ''}</td></tr>`),
          'Nothing is waiting to be paid.', 'Open payment links'), { id: 'links-title', sub: 'Every finalised invoice has a signed link. It is in the invoice email and on the customer\'s billing page.' })}</div>
        <aside class="pay-col">${card('How it works', h`<ol class="pay-steps">
          <li>The page shows the order: its lines, tax and what is left to pay, with the PDF.</li>
          <li>The card form is ${isStripe() ? 'Stripe\'s Payment Element' : 'the provider\'s hosted fields (a stand-in frame on the mock provider)'}: card numbers never touch your pages.</li>
          <li><strong>Save this card</strong> makes it the customer's default for the next invoices.</li>
          <li>Add <code>?return=/your/page</code> (your own site only) for a <em>Back to</em> link and, after paying, a return to <code>/your/page?payment=succeeded&amp;invoice=…</code>.</li>
        </ol>`, { id: 'how-title' })}</aside>
      </div>`);
  },

  // ---- Books --------------------------------------------------------------------------------------------------------

  async overview() {
    const o = await api(`${PAY}/overview`);
    mount(h`${header('Overview', `Money in ${o.currency}, this calendar month (UTC).`)}
      <div class="pay-stats">
        ${stat('Revenue this month', money(o.revenueThisMonth), { tone: 'teal' })}
        ${stat('MRR (last month)', money(o.mrr))}
        ${stat('Open invoices', money(o.open.amount), { sub: `${o.open.count} open` })}
        ${stat('Overdue', money(o.overdue.amount), { sub: `${o.overdue.count} retrying`, tone: o.overdue.count ? 'danger' : '' })}
        ${stat('Failed payments (30 days)', String(o.failedPayments30d))}
        ${stat('Accounts', String(o.accounts.total), { sub: `${o.accounts.delinquent} delinquent` })}
        ${stat('Reconciliation issues', String(o.openIssues))}
        ${stat('Ledger', o.ledgerBalanced ? 'Balanced' : 'Unbalanced', { tone: o.ledgerBalanced ? 'teal' : 'danger' })}
      </div>`);
  },

  async accounts(params) {
    const q = (params.get('q') ?? '').toLowerCase();
    const { items } = await api(`${PAY}/accounts?limit=500&sort=name`);
    const rows = items.filter((a) => !q || `${a.name} ${a.email} ${a.externalRef ?? ''}`.toLowerCase().includes(q)).map((a) => h`<tr>
      <td><a class="pay-strong" href="#/accounts/${encodeURIComponent(a.id)}">${a.name}</a><span class="pay-sub">${a.email}</span></td>
      <td class="pay-mono">${a.externalRef ?? '—'}</td><td>${a.currency}</td><td>${pill(a.status)}</td><td class="pay-num">${money(a.creditBalance)}</td></tr>`);
    mount(h`${header('Accounts', 'One billing account per paying customer.')}
      ${card('Accounts', h`<div class="pay-toolbar">${searchBox('search', q, 'Search accounts', 'Search name, email or reference')}</div>
      ${table([{ label: 'Account' }, { label: 'Reference' }, { label: 'Currency' }, { label: 'Status' }, { label: 'Credit', num: true }], rows, 'No accounts yet.', 'Accounts')}`, { id: 'accounts-title' })}`);
  },

  async account(params, id) {
    const [a, methods, invoices, payments, ledger, subs] = await Promise.all([
      api(`${PAY}/accounts/${id}`), api(`${PAY}/accounts/${id}/methods`), api(`${BILL}/invoices?filter[accountId]=${id}&limit=100&sort=-createdAt`).catch(() => ({ items: [] })),
      api(`${PAY}/payments?filter[accountId]=${id}&limit=50&sort=-createdAt`), api(`${PAY}/accounts/${id}/ledger`), api(`${BILL}/subscriptions?filter[accountId]=${id}`).catch(() => ({ items: [] })),
    ]);
    mount(h`${header(a.name, `${a.email} · ${a.currency}${a.country ? ` · ${a.country}` : ''}${a.taxId ? ` · VAT ${a.taxId}` : ''}`, { eyebrow: { href: '#/accounts', text: 'Accounts' } })}
      <div class="pay-stats">${stat('Status', h`${pill(a.status)}`, { sub: `Reference ${a.externalRef ?? '—'}` })}${stat('Credit', money(a.creditBalance))}${stat('Orders', String(invoices.items.length))}${stat('Cards', String(methods.items.length))}</div>
      ${card('Cards', table([{ label: 'Card' }, { label: 'Expires' }, { label: '' }], methods.items.map((m) => h`<tr><td>${cardText(m.display)}</td><td>${String(m.display.expMonth).padStart(2, '0')}/${m.display.expYear}</td><td>${m.id === a.defaultMethodId ? pill('default', 'Default') : ''}</td></tr>`), 'No card on file.', 'Cards'), { id: 'cards-title' })}
      ${card('Subscriptions', table([{ label: 'Subscription' }, { label: 'Status' }, { label: 'Period' }, { label: 'Items', num: true }], subs.items.map((s) => h`<tr><td class="pay-mono">${s.id}</td><td>${pill(s.pausedAt ? 'paused' : s.status)}</td><td>${day(s.currentPeriod.start)} – ${day(s.currentPeriod.end)}</td><td class="pay-num">${s.items.length}</td></tr>`), 'No subscription.', 'Subscriptions'), { id: 'subs-title' })}
      ${card('Orders', invoiceRows(invoices.items, 'No orders.'), { id: 'acc-orders-title' })}
      ${card('Payments', table([{ label: 'When' }, { label: 'Order' }, { label: 'Status' }, { label: 'Why' }, { label: 'Amount', num: true }], payments.items.map((p) => h`<tr><td>${when(p.createdAt)}</td><td>${p.invoiceId ? h`<a href="#/orders/${encodeURIComponent(p.invoiceId)}?payment=${encodeURIComponent(p.id)}">Open</a>` : '—'}</td><td>${pill(payState(p))}</td><td class="pay-wrap">${p.failure?.message ?? p.trigger}</td><td class="pay-num">${money(p.amount)}</td></tr>`), 'No payments.', 'Payments'), { id: 'acc-pay-title' })}
      ${card('Ledger', h`<p class="pay-card-sub">${Object.entries(ledger.balances).filter(([, v]) => v).map(([k, v]) => `${k.replace('_', ' ')} ${money({ amount: v, currency: a.currency })}`).join(' · ') || 'No postings.'}</p>
        ${table([{ label: 'When' }, { label: 'Account' }, { label: 'Memo' }, { label: 'Debit', num: true }, { label: 'Credit', num: true }], ledger.items.slice(-50).reverse().map((e) => h`<tr><td>${when(e.at)}</td><td>${e.account.replace('_', ' ')}</td><td class="pay-wrap">${e.memo}</td><td class="pay-num">${e.debit ? money({ amount: e.debit, currency: e.currency }) : ''}</td><td class="pay-num">${e.credit ? money({ amount: e.credit, currency: e.currency }) : ''}</td></tr>`), 'No postings.', 'Ledger')}`, { id: 'ledger-title' })}`);
  },

  async plans() {
    const [meters, products, prices] = await Promise.all([api(`${BILL}/meters`), api(`${BILL}/products?limit=500&sort=name`), api(`${BILL}/prices?limit=500`)]);
    const productName = (id) => products.items.find((p) => p.id === id)?.name ?? id;
    const meterKey = (id) => meters.items.find((m) => m.id === id)?.key ?? '';
    const priceText = (p) => (p.tiers ? `${p.tiers.length} tiers` : `${money({ amount: p.unitAmount, currency: p.currency })}${p.divideBy ? ` per ${p.divideBy === 'month_hours' ? 'month, by the hour' : `${p.divideBy} units`}` : p.meterId ? ' per unit' : p.interval ? ` a ${p.interval}` : ''}`);
    mount(h`${header('Plans', 'Products, prices and meters. A price that has been used never changes: add a new one and turn the old one off.')}
      ${card('Prices', table([{ label: 'Product' }, { label: 'Type' }, { label: 'Price' }, { label: 'Meter' }, { label: 'Key' }, { label: 'Status' }, { label: '' }], prices.items.sort((a, b) => productName(a.productId).localeCompare(productName(b.productId))).map((p) => h`<tr>
        <td>${productName(p.productId)}</td><td>${p.type.replace('_', ' ')}</td><td class="pay-num">${priceText(p)}${p.freeAllowance ? ` · ${p.freeAllowance} free` : ''}</td><td class="pay-mono">${meterKey(p.meterId)}</td><td class="pay-mono">${p.key ?? ''}</td>
        <td>${pill(p.active ? 'active' : 'inactive')}</td>
        <td><button type="button" class="pay-link-btn" data-action="toggle-price" data-id="${p.id}" data-active="${p.active ? '1' : ''}">${p.active ? 'Turn off' : 'Turn on'}</button></td></tr>`), 'No prices.', 'Prices'), { id: 'prices-title' })}
      ${card('New price', h`<form data-action="new-price"><div class="pay-form-grid">
        <div class="pay-field"><label class="form-label" for="np-product">Product</label><select class="form-select" id="np-product" name="productId" required>${products.items.map((p) => h`<option value="${p.id}">${p.name}</option>`)}</select></div>
        <div class="pay-field"><label class="form-label" for="np-type">Type</label><select class="form-select" id="np-type" name="type"><option value="metered">Metered</option><option value="per_unit">Per unit</option><option value="flat">Flat</option></select></div>
        <div class="pay-field"><label class="form-label" for="np-amount">Unit amount (USD)</label><input class="form-control" id="np-amount" name="amount" inputmode="decimal" required></div>
        <div class="pay-field"><label class="form-label" for="np-meter">Meter</label><select class="form-select" id="np-meter" name="meter"><option value="">None</option>${meters.items.map((m) => h`<option value="${m.key}">${m.key}</option>`)}</select></div>
        <div class="pay-field"><label class="form-label" for="np-divide">Divide by</label><select class="form-select" id="np-divide" name="divideBy"><option value="">Nothing</option><option value="month_hours">Hours in the month</option></select></div>
        </div><button class="pay-btn pay-btn-primary" type="submit">Add price</button></form>`, { id: 'new-price-title' })}
      ${card('Meters', table([{ label: 'Key' }, { label: 'Name' }, { label: 'Unit' }, { label: 'Aggregate' }], meters.items.map((m) => h`<tr><td class="pay-mono">${m.key}</td><td>${m.name}</td><td>${m.unit}</td><td>${m.aggregate}</td></tr>`), 'No meters.', 'Meters'), { id: 'meters-title' })}`);
  },

  async dunning() {
    const { items } = await api(`${PAY}/dunning?limit=200`);
    mount(h`${header('Dunning', 'Invoices whose payment failed: retried on schedule, then written off and the account marked delinquent.', { eyebrow: { href: '#/recurring', text: 'Recurring' } })}
      ${card('Retrying', table([{ label: 'Order' }, { label: 'Status' }, { label: 'Attempts' }, { label: 'Next attempt' }, { label: 'Last failure' }, { label: 'Left to pay', num: true }], items.map((i) => h`<tr>
        <td><a href="#/orders/${encodeURIComponent(i.id)}">${i.number}</a><span class="pay-sub">${i.billingDetails?.name ?? ''}</span></td><td>${pill(orderState(i))}</td><td>${i.attempts}</td><td>${when(i.nextAttemptAt)}</td><td class="pay-wrap">${i.lastFailure?.message ?? ''}</td><td class="pay-num">${money(i.amountRemaining)}</td></tr>`), 'Nothing is being retried.', 'Retrying'), { id: 'dunning-title' })}`);
  },

  async issues() {
    const { items } = await api(`${PAY}/reconciliation/issues?limit=200&sort=-at`);
    mount(h`${header('Reconciliation', 'Where the provider and this ledger disagree. Recorded, never silently fixed.')}
      ${card('Issues', table([{ label: 'When' }, { label: 'Kind' }, { label: 'What happened' }, { label: 'Status' }, { label: '' }], items.map((i) => h`<tr><td>${when(i.at)}</td><td>${i.kind.replace(/_/g, ' ')}</td><td class="pay-wrap">${i.message}</td><td>${pill(i.status)}</td>
        <td>${i.status === 'open' ? h`<button type="button" class="pay-link-btn" data-action="resolve" data-id="${i.id}">Resolve</button>` : ''}</td></tr>`), 'No issues.', 'Issues'), { id: 'issues-title' })}`);
  },

  // ---- Setup --------------------------------------------------------------------------------------------------------

  async setup() {
    const p = await providerInfo();
    const facts = (rows) => h`<dl class="pay-kv">${rows.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
    const body = p.name === 'stripe'
      ? card('Connected to Stripe', h`${facts([
        ['Status', pill(p.account ? 'active' : 'failed', p.account ? 'Connected' : 'Key refused')],
        ['Mode', pill(p.mode)],
        ['Account', h`<span class="pay-mono">${p.account ?? '—'}</span>`],
        ['Business name', p.accountName ?? '—'],
        ['Publishable key', p.publishableKey ? 'Set' : 'Missing: the card form cannot load'],
        ['Webhook signing secret', p.webhookSecret ? 'Set' : 'Missing'],
      ])}${p.dashboard ? h`<div class="pay-panel-actions"><a class="pay-btn" href="${p.dashboard}" target="_blank" rel="noopener">Open the Stripe dashboard<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a></div>` : ''}`, { id: 'conn-title', sub: 'Keys come from the host\'s environment; they are never shown or stored here.' })
      : card('Not connected: test cards only', h`<p class="pay-card-sub">The mock provider is running. It takes the test cards (4242 4242 4242 4242 pays; 4000 0000 0000 0341 is saved, then declined; 4000 0027 6000 3184 asks for 3-D Secure) and never moves money. It is refused in production.</p>
        <h3 class="pay-section-label">To connect Stripe</h3>
        <ol class="pay-steps"><li>In the Stripe dashboard, copy the secret key, the publishable key and (after the next step) the webhook signing secret.</li>
          <li>Add the webhook endpoint (see Webhooks) for the events listed there.</li>
          <li>Give the host the keys through its environment (for NooblyJS Cloud: <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PUBLISHABLE_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>) and restart it. Test keys (<code>sk_test_…</code>) are test mode.</li></ol>
        ${facts([['Mode', pill('test')], ['Account', h`<span class="pay-mono">${p.account ?? '—'}</span>`]])}`, { id: 'conn-title' });
    mount(h`${header('Stripe connection', 'The payment provider this accelerator charges cards through.')}${body}`);
  },

  async webhooks() {
    const [p, { items }] = await Promise.all([providerInfo(), api(`${PAY}/webhooks?limit=200`)]);
    mount(h`${header('Webhooks', `Events ${providerWord()} sends here: checked against the signing secret, recorded once, then applied.`)}
      <div class="pay-grid"><div class="pay-col">
        ${card('Received', table([{ label: 'Received' }, { label: 'Event' }, { label: 'Provider event' }, { label: 'Result' }],
          items.map((w) => h`<tr><td>${when(w.receivedAt)}</td><td class="pay-mono">${w.type}</td><td class="pay-mono">${w.eventId}</td><td>${w.processedAt ? pill(w.result === 'error' ? 'failed' : 'processed', w.result ?? 'Processed') : pill('pending', 'Waiting')}</td></tr>`),
          'No events yet.', 'Received events'), { id: 'received-title', sub: `${plural(p.received ?? items.length, 'event')}${p.lastEventAt ? ` · last ${when(p.lastEventAt)}` : ''}` })}
      </div><aside class="pay-col">
        ${card('Endpoint', h`<pre class="pay-code">${p.webhookUrl}</pre>
          <div class="pay-panel-actions"><button type="button" class="pay-btn" data-action="copy" data-text="${p.webhookUrl}"><i class="bi bi-clipboard" aria-hidden="true"></i>Copy the URL</button></div>
          <h3 class="pay-section-label">Events to send</h3><ul class="pay-preview">${(p.webhookEvents ?? []).map((e) => h`<li class="pay-mono">${e}</li>`)}</ul>
          <p class="pay-note">${p.name === 'stripe' ? 'Mount the accelerator before any JSON body parser: the signature is checked on the raw body.' : 'The mock provider signs its events with a test secret.'}</p>`, { id: 'endpoint-title' })}
      </aside></div>`);
  },
};

function orderLines(inv) {
  return card('What it was for', h`${table([{ label: 'Description' }, { label: 'Amount', num: true }], inv.lines.map((l) => h`<tr><td class="pay-wrap">${l.description}${l.period ? h`<span class="pay-sub">${day(l.period.start)} – ${day(new Date(Date.parse(l.period.end) - 1).toISOString())}</span>` : ''}</td><td class="pay-num">${money(l.amount)}</td></tr>`), 'No lines.', 'Lines')}
    <dl class="pay-kv">
      <dt>Subtotal</dt><dd class="pay-num">${money(inv.subtotal)}</dd>
      ${inv.taxLines.map((t) => h`<dt>${t.name} ${t.rate / 100}%${t.inclusive ? ' (included)' : ''}</dt><dd class="pay-num">${money(t.amount)}</dd>`)}
      <dt>Total</dt><dd class="pay-num pay-strong">${money(inv.total)}</dd>
      ${inv.creditApplied?.amount ? h`<dt>Credit applied</dt><dd class="pay-num">−${money(inv.creditApplied)}</dd>` : ''}
      ${inv.credited?.amount ? h`<dt>Credited</dt><dd class="pay-num">−${money(inv.credited)}</dd>` : ''}
      <dt>Left to pay</dt><dd class="pay-num">${money(inv.amountRemaining)}</dd>
      ${inv.attempts ? h`<dt>Attempts</dt><dd>${inv.attempts}${inv.nextAttemptAt ? ` · next ${when(inv.nextAttemptAt)}` : ''}${inv.lastFailure ? ` · ${inv.lastFailure.message}` : ''}</dd>` : ''}
    </dl>
    <div class="pay-panel-actions">
      <a class="pay-btn pay-btn-sm" href="${BILL}/invoices/${inv.id}.pdf" target="_blank" rel="noopener"><i class="bi bi-file-earmark-pdf" aria-hidden="true"></i>PDF</a>
      ${inv.status === 'open' ? h`<button type="button" class="pay-btn pay-btn-sm" data-action="invoice" data-op="send" data-id="${inv.id}">Email again</button>
        <button type="button" class="pay-btn pay-btn-sm pay-btn-danger" data-action="invoice" data-op="mark-uncollectible" data-id="${inv.id}">Write off</button>` : ''}
      ${['open', 'draft'].includes(inv.status) ? h`<button type="button" class="pay-btn pay-btn-sm pay-btn-danger" data-action="invoice" data-op="void" data-id="${inv.id}">Void</button>` : ''}
    </div>
    ${['open', 'paid'].includes(inv.status) ? h`<h3 class="pay-section-label">Credit note</h3>
    <form data-action="credit-note" data-id="${inv.id}" data-currency="${inv.currency}"><div class="pay-form-grid">
      <div class="pay-field"><label class="form-label" for="cn-amount">Amount (${inv.currency})</label><input class="form-control" id="cn-amount" name="amount" inputmode="decimal" required></div>
      <div class="pay-field"><label class="form-label" for="cn-reason">Reason</label><input class="form-control" id="cn-reason" name="reason" required minlength="3"></div></div>
      ${inv.status === 'paid' ? h`<div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="cn-refund" name="refund"><label class="form-check-label" for="cn-refund">Refund it to the card</label></div>` : ''}
      <button class="pay-btn pay-btn-sm" type="submit">Issue credit note</button></form>` : ''}
    ${inv.creditNotes.length ? h`<h3 class="pay-section-label">Credit notes</h3>${table([{ label: 'Number' }, { label: 'Reason' }, { label: 'Amount', num: true }], inv.creditNotes.map((n) => h`<tr><td class="pay-mono">${n.number}</td><td>${n.reason}${n.refundId ? ' (refunded)' : ''}</td><td class="pay-num">${money(n.amount)}</td></tr>`), '', 'Credit notes')}` : ''}`,
  { id: 'lines-title', sub: `${inv.number ?? 'Draft'} · ${WORDS[inv.status] ?? inv.status}` });
}

function paymentPanel(p, inv) {
  const state = payState(p);
  const events = [{ at: p.createdAt, text: `Charge started (${p.trigger === 'automatic' ? 'automatic' : 'by hand'}, attempt ${p.attempt})`, tone: 'neutral' }];
  if (p.status === 'succeeded') events.push({ at: p.updatedAt ?? p.createdAt, text: `Succeeded · ${money(p.amount)}` });
  if (p.status === 'failed') events.push({ at: p.updatedAt ?? p.createdAt, text: `Failed · ${p.failure?.message ?? 'declined'}`, tone: 'bad' });
  if (p.status === 'requires_action') events.push({ at: p.updatedAt ?? p.createdAt, text: 'Waiting for the cardholder\'s 3-D Secure check', tone: 'neutral' });
  for (const r of [...(p.refunds ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) events.push({ at: r.createdAt, text: `Refunded ${money(r.amount)} · ${r.reason}`, tone: 'neutral' });
  const meta = Object.entries({ invoiceId: p.invoiceId, accountId: p.accountId, paymentId: p.id }).map(([k, v]) => `${k}: ${v}`).join('\n');
  const refundable = p.status === 'succeeded' && (p.refunded?.amount ?? 0) < p.amount.amount;
  return card('Payment details', h`${pill(state)}
    <p class="pay-panel-amount">${money(p.amount)}</p><p class="pay-card-sub">${when(p.createdAt)}</p>
    <dl class="pay-kv">
      <dt>Payment ID</dt><dd class="pay-mono">${p.id}</dd>
      <dt>Charge</dt><dd class="pay-mono">${p.providerRef ?? '—'}</dd>
      <dt>Method</dt><dd>${cardText(p.method)}${p.method ? ` · ${String(p.method.expMonth).padStart(2, '0')}/${String(p.method.expYear).slice(-2)}` : ''}</dd>
      <dt>Refunded</dt><dd>${p.refunded?.amount ? money(p.refunded) : 'Nothing'}</dd>
      <dt>Attempt</dt><dd>${p.attempt ?? 1} · ${p.trigger === 'automatic' ? 'automatic' : 'by hand'}</dd>
      <dt>Receipt</dt><dd>${p.status === 'succeeded' ? `Emailed to ${inv.billingDetails?.email ?? 'the customer'}` : '—'}</dd>
    </dl>
    <h3 class="pay-section-label">Timeline</h3>
    <ol class="pay-timeline">${events.map((e) => h`<li class="${e.tone ? `pay-tl-${e.tone}` : ''}">${e.text}<span class="pay-sub">${when(e.at)}</span></li>`)}</ol>
    <h3 class="pay-section-label">Metadata sent to ${providerWord()}</h3>
    <pre class="pay-code">${meta}</pre>
    <div class="pay-panel-actions">
      ${refundable ? h`<a class="pay-btn pay-btn-primary" href="#/refund/${encodeURIComponent(p.id)}"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>Refund</a>` : ''}
      ${isStripe() && stripeLink(p.providerRef) ? h`<a class="pay-btn" href="${stripeLink(p.providerRef)}" target="_blank" rel="noopener">Open in Stripe<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>` : ''}
    </div>`, { id: 'detail-title' });
}

function invoiceRows(items, empty) {
  return table([{ label: 'Order' }, { label: 'Date' }, { label: 'Status' }, { label: 'Total', num: true }, { label: 'Left to pay', num: true }], items.map((i) => h`<tr>
    <td><a class="pay-strong" href="#/orders/${encodeURIComponent(i.id)}">${i.number ?? 'Draft'}</a></td><td>${day(i.finalizedAt ?? i.createdAt)}</td>
    <td>${pill(orderState(i))}</td><td class="pay-num">${money(i.total)}</td><td class="pay-num">${money(i.amountRemaining)}</td></tr>`), empty, 'Orders');
}

/** The New schedule form's "Next charges": today, then each month or year on the billing day. */
function schedulePreview(form) {
  const box = form?.querySelector('[data-schedule-preview]');
  if (!box) return;
  const interval = form.interval.value;
  const amount = toMinor(form.amount.value);
  const now = new Date();
  const dates = [now];
  for (let n = 1; n < 4; n += 1) {
    const d = form.anchor.value === 'calendar'
      ? new Date(Date.UTC(now.getUTCFullYear() + (interval === 'year' ? n : 0), interval === 'year' ? 0 : now.getUTCMonth() + n, 1))
      : new Date(Date.UTC(now.getUTCFullYear() + (interval === 'year' ? n : 0), now.getUTCMonth() + (interval === 'year' ? 0 : n), Math.min(now.getUTCDate(), 28)));
    dates.push(d);
  }
  box.innerHTML = render(dates.map((d, n) => h`<li>${n === 0 ? 'Today' : day(d.toISOString())}${amount ? ` · ${usd(amount)}` : ''}</li>`));
}

/** The refund form's summary and button, as the amount changes. */
function refundTotals(form) {
  const cur = form.dataset.currency;
  const left = Number(form.dataset.left);
  const before = Number(form.dataset.before);
  const original = Number(form.dataset.original);
  const all = form.how.value === 'all';
  const input = form.amount;
  if (all) { input.value = fromMinor(left, cur); input.readOnly = true; } else input.readOnly = false;
  const value = toMinor(input.value, cur);
  const ok = value !== null && value > 0 && value <= left;
  const thisOne = ok ? value : 0;
  main.querySelector('[data-sum="this"]').textContent = `−${usd(thisOne, cur)}`;
  main.querySelector('[data-sum="keep"]').textContent = usd(original - before - thisOne, cur);
  form.querySelector('[data-refund-submit]').textContent = ok ? `Refund ${usd(value, cur)}` : 'Refund';
  return { value, ok, left };
}

function fieldError(form, name, message) {
  const box = form.querySelector(`[data-error="${name}"]`);
  const input = form.elements[name];
  if (box) box.textContent = message ?? '';
  if (input) { input.classList.toggle('is-invalid', Boolean(message)); if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  if (message) input?.focus();
}

// ---- router and actions -----------------------------------------------------------------------------------------

const ROUTES = [
  [/^\/orders\/([^/]+)$/, 'orders', (p, m) => views.order(p, decodeURIComponent(m[1]))],
  [/^\/orders$/, 'orders', (p) => views.orders(p)],
  [/^\/invoices\/([^/]+)$/, 'orders', (p, m) => views.order(p, decodeURIComponent(m[1]))],
  [/^\/invoices$/, 'orders', (p) => views.orders(p)],
  [/^\/payments$/, 'orders', (p) => views.orders(p)],
  [/^\/refund\/([^/]+)$/, 'refunds', (p, m) => views.refund(p, decodeURIComponent(m[1]))],
  [/^\/refunds$/, 'refunds', (p) => views.refunds(p)],
  [/^\/recurring$/, 'recurring', (p) => views.recurring(p)],
  [/^\/dunning$/, 'recurring', () => views.dunning()],
  [/^\/checkout$/, 'checkout', () => views.checkout()],
  [/^\/overview$/, 'overview', () => views.overview()],
  [/^\/accounts\/([^/]+)$/, 'accounts', (p, m) => views.account(p, decodeURIComponent(m[1]))],
  [/^\/accounts$/, 'accounts', (p) => views.accounts(p)],
  [/^\/plans$/, 'plans', () => views.plans()],
  [/^\/issues$/, 'issues', () => views.issues()],
  [/^\/setup$/, 'setup', () => views.setup()],
  [/^\/webhooks$/, 'webhooks', () => views.webhooks()],
];

let lastPath = null;
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/orders';
  const [path, query = ''] = hash.split('?');
  const found = ROUTES.map(([re, nav, view]) => ({ m: re.exec(path), nav, view })).find((r) => r.m);
  if (!found) { location.hash = '#/orders'; return; }
  document.querySelectorAll('[data-pay-nav]').forEach((a) => {
    const on = a.dataset.payNav === found.nav;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const moved = path !== lastPath;
  lastPath = path;
  if (moved) mount(h`<p class="pay-loading" role="status">Loading…</p>`);
  try {
    await found.view(new URLSearchParams(query), found.m);
    if (moved) { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  } catch (err) {
    mount(h`<div class="pay-alert pay-alert-bad" role="alert"><i class="bi bi-exclamation-octagon" aria-hidden="true"></i><div>${err.message}</div></div>`);
  }
}

async function drawProvider() {
  const p = await providerInfo();
  document.getElementById('pay-provider').innerHTML = render(h`<div class="pay-provider-card">${pill(p.mode, `${p.name === 'stripe' ? 'Stripe' : p.label} · ${p.mode} mode`)}<span class="pay-mono" title="${p.account ?? ''}">${p.account ?? 'Not connected'}</span></div>`);
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

main.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-action]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('[type="submit"]');
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  try {
    switch (form.dataset.action) {
      case 'search': go(hashOf('/accounts', { q: data.q })); return;
      case 'order-list-search': go(hashOf('/orders', { show: params.get('show'), q: data.q })); return;
      case 'order-search': go(hashOf(location.hash.slice(1).split('?')[0], { show: params.get('show'), payment: params.get('payment'), q: data.q })); return;
      case 'refund-search': go(hashOf('/refunds', { q: data.q })); return;
      case 'refund': {
        const { value, ok, left } = refundTotals(form);
        fieldError(form, 'amount', null);
        if (value === null) return fieldError(form, 'amount', 'Write the amount as a number, such as 12.50.');
        if (!ok) return fieldError(form, 'amount', value > left ? `At most ${usd(left, form.dataset.currency)} is left to refund.` : 'More than nothing.');
        const label = REASONS.find(([v]) => v === data.reasonCode)?.[1] ?? 'Other';
        submit.disabled = true;
        submit.textContent = 'Refunding…';
        const r = await api(`${PAY}/refunds`, { method: 'POST', body: { paymentId: form.dataset.id, amount: value, reasonCode: data.reasonCode, reason: data.note?.trim() || label, notifyCustomer: data.notify === 'on' }, idempotent: true });
        go(`#/refund/${encodeURIComponent(form.dataset.id)}?done=${encodeURIComponent(r.id)}`);
        return;
      }
      case 'take-payment': {
        const amount = toMinor(data.amount);
        fieldError(form, 'amount', null);
        if (!data.description.trim()) { form.description.focus(); throw new Error('Say what the payment is for.'); }
        if (!amount) return fieldError(form, 'amount', 'Write the amount as a number, such as 49.00.');
        submit.disabled = true;
        const inv = await api(`${BILL}/invoices`, { method: 'POST', body: { accountId: data.accountId, lines: [{ description: data.description.trim(), amount }], collect: data.collect !== 'link' }, idempotent: true });
        toast(inv.status === 'paid' ? `Paid: ${inv.number}.` : data.collect === 'link' ? `Payment link for ${inv.number} emailed.` : `${inv.number} was not paid: ${inv.lastFailure?.message ?? 'see the order'}.`, inv.status !== 'paid' && data.collect !== 'link');
        go(`#/orders/${encodeURIComponent(inv.id)}`);
        return;
      }
      case 'new-schedule': {
        const unitAmount = toMinor(data.amount);
        fieldError(form, 'description', null);
        fieldError(form, 'amount', null);
        if (!data.description.trim()) return fieldError(form, 'description', 'Say what the customer pays for.');
        if (!unitAmount) return fieldError(form, 'amount', 'Write the amount as a number, such as 49.00.');
        submit.disabled = true;
        const product = await api(`${BILL}/products`, { method: 'POST', body: { name: data.description.trim() } });
        const price = await api(`${BILL}/prices`, { method: 'POST', body: { productId: product.id, type: 'flat', unitAmount, interval: data.interval } });
        await api(`${BILL}/subscriptions`, { method: 'POST', body: { accountId: data.accountId, items: [{ priceId: price.id }], anchor: data.anchor }, idempotent: true });
        toast('Schedule created; the first charge is on its way.');
        break;
      }
      case 'credit-note': {
        const amount = toMinor(data.amount, form.dataset.currency);
        if (amount === null) throw new Error('The amount is a number such as 12.50.');
        await api(`${BILL}/credit-notes`, { method: 'POST', body: { invoiceId: form.dataset.id, amount, reason: data.reason, refund: data.refund === 'on' }, idempotent: true });
        toast('Credit note issued.');
        break;
      }
      case 'new-price': {
        const unitAmount = toMinor(data.amount, 'USD');
        if (unitAmount === null) throw new Error('The amount is a number such as 5.00.');
        await api(`${BILL}/prices`, { method: 'POST', body: { productId: data.productId, type: data.type, unitAmount, ...(data.meter ? { meter: data.meter } : {}), ...(data.divideBy ? { divideBy: data.divideBy } : {}) } });
        toast('Price added.');
        break;
      }
      default: return;
    }
    route();
  } catch (err) {
    if (submit) { submit.disabled = false; if (form.dataset.action === 'refund') refundTotals(form); }
    toast(err.details?.length ? `${err.message} ${err.details.map((d) => d.message).join(' ')}` : err.message, true);
  }
});

main.addEventListener('input', (e) => {
  const refund = e.target.closest('form[data-action="refund"]');
  if (refund) refundTotals(refund);
  const schedule = e.target.closest('form[data-action="new-schedule"]');
  if (schedule) schedulePreview(schedule);
});
main.addEventListener('change', (e) => {
  const refund = e.target.closest('form[data-action="refund"]');
  if (refund && e.target.name === 'how') {
    refundTotals(refund);
    if (e.target.value === 'part') { refund.amount.focus(); refund.amount.select(); }
  }
  const schedule = e.target.closest('form[data-action="new-schedule"]');
  if (schedule) schedulePreview(schedule);
});

main.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(btn.dataset.text);
      toast('Link copied.');
    } catch {
      toast(`Copy this link: ${btn.dataset.text}`);
    }
    return;
  }
  if (action === 'hide-take') { go('#/orders'); return; }
  btn.disabled = true;
  try {
    if (action === 'invoice') {
      const op = btn.dataset.op;
      if (op === 'send') { await api(`${BILL}/invoices/${btn.dataset.id}/send`, { method: 'POST', body: {} }); toast('Emailed again.'); }
      else {
        const out = await api(`${BILL}/invoices/${btn.dataset.id}:${op}`, { method: 'POST', body: {}, idempotent: true });
        const inv = out.invoice ?? out;
        if (op === 'pay') toast(inv.status === 'paid' ? 'Paid.' : `Not paid: ${inv.lastFailure?.message ?? out.payment?.failure?.message ?? 'the card was declined.'}`, inv.status !== 'paid');
        else toast('Done.');
      }
    } else if (action === 'sub') {
      const op = btn.dataset.op;
      await api(`${BILL}/subscriptions/${btn.dataset.id}:${op}`, { method: 'POST', body: op === 'cancel' ? { atPeriodEnd: true } : {}, idempotent: true });
      toast(op === 'cancel' ? 'It ends at the end of this period.' : op === 'pause' ? 'Paused: no charges until it is resumed.' : 'Resumed.');
    } else if (action === 'toggle-price') {
      await api(`${BILL}/prices/${btn.dataset.id}`, { method: 'PATCH', body: { active: !btn.dataset.active } });
    } else if (action === 'resolve') {
      await api(`${PAY}/reconciliation/issues/${btn.dataset.id}:resolve`, { method: 'POST', body: {} });
    }
    route();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

window.addEventListener('hashchange', route);
drawProvider();
route();
