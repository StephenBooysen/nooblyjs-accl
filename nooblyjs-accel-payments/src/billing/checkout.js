// The hosted checkout (the *Hosted checkout* and *Payment success* mock-ups in .claude/steering/ui): the page a signed
// invoice link opens. An open invoice shows what it is for and a card form (the provider's hosted fields) that pays it;
// a paid one shows the receipt and, when the link came from the host's app with a return address, goes back there.
// Server-rendered, no inline style or script (core's CSP): the stylesheets and checkout.js are files under ../assets/.
import { format } from '../shared/money.js';
import { STATUS_WORDS, titleOf } from './document.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const when = (iso) => (iso ? `${day(iso)} · ${new Date(iso).toISOString().slice(11, 16)} UTC` : '');
const periodText = (p) => (p ? `${day(p.start)} – ${day(new Date(Date.parse(p.end) - 1).toISOString())}` : '');
const brandCard = (d) => (d ? `${d.brand[0].toUpperCase()}${d.brand.slice(1)} ·· ${d.last4}` : '');

/** The page around every public screen: the theme, our stylesheet, the brand bar. */
export function publicPage(title, body, { brand, mode = null, back = null, scripts = [], depth = 1 }) {
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(brand)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
<link rel="stylesheet" href="${up}assets/styles.css"><link rel="stylesheet" href="${up}assets/invoice.css"></head>
<body class="pay-public">
<header class="pay-co-top">
  <div class="pay-co-top-side">${back ? `<a class="pay-co-back" href="${esc(back)}"><i class="bi bi-arrow-left" aria-hidden="true"></i> Back to ${esc(brand)}</a>` : ''}</div>
  <div class="pay-co-brand"><span class="pay-co-initial" aria-hidden="true">${esc(String(brand).trim()[0]?.toUpperCase() ?? 'P')}</span><span>${esc(brand)}</span></div>
  <div class="pay-co-top-side pay-co-top-end">${mode === 'test' ? '<span class="pay-co-mode">Test mode</span>' : ''}</div>
</header>
<main class="pay-co-main">${body}</main>
${scripts.map((s) => (typeof s === 'string' ? `<script src="${esc(s)}" type="module"></script>` : `<script src="${esc(s.src)}"></script>`)).join('')}
</body></html>`;
}

const addressLines = (a) => (a ? [a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean) : []);

/** Who sold and who bought, with VAT numbers: a South African tax invoice (O4) carries both, on the page as on the PDF. */
function parties(inv, brand) {
  const s = inv.seller ?? { name: brand };
  const b = inv.billingDetails ?? {};
  const block = (title, p, extra = []) => `<div><h2 class="pay-co-party-title">${esc(title)}</h2><p class="pay-co-party"><strong>${esc(p.name ?? '')}</strong>${[...extra, ...addressLines(p.address)].map((l) => `<br>${esc(l)}`).join('')}${p.taxId ? `<br>VAT number ${esc(p.taxId)}` : ''}</p></div>`;
  return `<div class="pay-co-card pay-co-parties"><p class="pay-co-doc"><strong>${esc(titleOf(inv))}</strong> ${esc(inv.number ?? '')} · ${esc(day(inv.finalizedAt))}</p>
    <div class="pay-co-party-grid">${block('From', s, s.email ? [s.email] : [])}${block('Billed to', b, b.email ? [b.email] : [])}</div></div>`;
}

function orderSummary(inv) {
  const lines = inv.lines.map((l) => `<li class="pay-co-line">
    <div><div class="pay-co-line-name">${esc(l.description)}</div>${l.period ? `<div class="pay-co-line-sub">${esc(periodText(l.period))}</div>` : l.quantity > 1 ? `<div class="pay-co-line-sub">Qty ${esc(l.quantity)}</div>` : ''}</div>
    <div class="pay-co-num">${esc(format(l.amount))}</div></li>`).join('');
  const row = (label, m, cls = '') => `<div class="pay-co-row ${cls}"><span>${esc(label)}</span><span class="pay-co-num">${esc(m)}</span></div>`;
  const rows = [row('Subtotal', format(inv.subtotal))];
  for (const t of inv.taxLines ?? []) rows.push(row(`${t.name} ${t.rate / 100}%${t.inclusive ? ' (included)' : ''}`, format(t.amount)));
  if (inv.creditApplied?.amount) rows.push(row('Account credit', `−${format(inv.creditApplied)}`));
  if (inv.credited?.amount) rows.push(row('Credited', `−${format(inv.credited)}`));
  if (inv.amountPaid?.amount && inv.status !== 'paid') rows.push(row('Paid already', `−${format(inv.amountPaid)}`));
  rows.push(row(inv.status === 'paid' ? 'Total paid' : 'Total due', format(inv.status === 'paid' ? inv.total : inv.amountRemaining), 'pay-co-row-total'));
  return `<div class="pay-co-card pay-co-summary"><ul class="pay-co-lines">${lines}</ul><div class="pay-co-rows">${rows.join('')}</div></div>`;
}

/**
 * An invoice that can be paid: what it is for, and the card form.
 * @param {object} inv
 * @param {{ brand: string, mode: string, providerLabel: string, token: string, pdfHref: string, returnUrl?: string|null, notice?: string|null, actionHref?: string|null, saveDefault?: boolean }} o
 */
export function checkoutHtml(inv, { brand, mode, providerLabel, token, pdfHref, returnUrl = null, notice = null, actionHref = null }) {
  const due = format(inv.amountRemaining);
  const b = inv.billingDetails ?? {};
  const body = `<section class="pay-co-order" aria-labelledby="pay-co-amount">
    <p class="pay-co-eyebrow">Pay ${esc(brand)}</p>
    <p class="pay-co-amount" id="pay-co-amount">${esc(due)}</p>
    <p class="pay-co-ref">${esc(titleOf(inv))} ${esc(inv.number)} · issued ${esc(day(inv.finalizedAt))}</p>
    ${orderSummary(inv)}
    ${parties(inv, brand)}
    <p class="pay-co-note"><i class="bi bi-info-circle" aria-hidden="true"></i> <span>${returnUrl ? `After you pay you go straight back to ${esc(brand)}. Leave this page any time to cancel and return without paying.` : `The card you add pays this invoice. ${esc(brand)} keeps it for your next invoices if you leave the box ticked.`}</span></p>
    <p class="pay-co-pdf"><a href="${esc(pdfHref)}"><i class="bi bi-file-earmark-pdf" aria-hidden="true"></i> Download the invoice (PDF)</a></p>
  </section>
  <section class="pay-co-card pay-co-pay" aria-labelledby="pay-co-pay-title">
    <h1 id="pay-co-pay-title">Payment</h1>
    ${notice ? `<p class="pay-co-notice" role="status">${esc(notice)}${actionHref ? ` <a href="${esc(actionHref)}">Confirm it now</a>.` : ''}</p>` : ''}
    <div class="pay-co-field"><span class="pay-co-label">Email</span><div class="pay-co-static">${esc(b.email ?? '')}</div></div>
    <div class="pay-co-field"><span class="pay-co-label" id="pay-co-card-label">Card details</span>
      <div id="pay-checkout" class="pay-co-cardform" data-token="${esc(token)}" data-due="${esc(due)}" data-return="${esc(returnUrl ?? '')}" aria-labelledby="pay-co-card-label"><p class="pay-co-muted">Loading the card form…</p></div></div>
    <label class="pay-co-save"><input type="checkbox" id="pay-co-save" checked>
      <span><strong>Save this card with ${esc(brand)}</strong><span class="pay-co-muted">It pays your next invoices. You can remove it on the Billing page any time.</span></span></label>
    <p class="pay-co-error" id="pay-co-error" role="alert"></p>
    <div class="pay-co-foot"><span><i class="bi bi-lock" aria-hidden="true"></i> Secured by ${esc(providerLabel)}</span><span>${mode === 'test' ? 'No card is charged in test mode.' : ''}</span></div>
  </section>`;
  return publicPage(`Pay ${titleOf(inv).toLowerCase()} ${inv.number}`, `<div class="pay-co-grid">${body}</div>`, { brand, mode, back: returnUrl, scripts: ['../assets/checkout.js'] });
}

/** A paid invoice: the receipt, and back to the host's app when the link came from it. */
export function successHtml(inv, { brand, mode, providerLabel, payment = null, card = null, pdfHref, returnUrl = null }) {
  const back = returnUrl ? `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}payment=succeeded&invoice=${encodeURIComponent(inv.number)}` : null;
  const body = `<section class="pay-co-card pay-co-success" aria-labelledby="pay-co-done">
    <div class="pay-co-tick" aria-hidden="true"><i class="bi bi-check-lg"></i></div>
    <h1 id="pay-co-done">Payment received</h1>
    <p class="pay-co-lead">${esc(format(inv.total))} paid to ${esc(brand)} for ${esc(titleOf(inv).toLowerCase())} ${esc(inv.number)}.</p>
    <dl class="pay-co-facts">
      ${card ? `<div><dt>Card</dt><dd>${esc(brandCard(card))}</dd></div>` : ''}
      <div><dt>Date</dt><dd>${esc(when(inv.paidAt ?? payment?.createdAt))}</dd></div>
      <div><dt>Receipt</dt><dd>Sent to ${esc(inv.billingDetails?.email ?? '')}</dd></div>
      ${payment?.providerRef ? `<div><dt>Reference</dt><dd class="pay-co-mono">${esc(payment.providerRef)}</dd></div>` : ''}
      <div><dt>Invoice</dt><dd><a href="${esc(pdfHref)}">${esc(inv.number)} (PDF)</a></dd></div>
    </dl>
    <details class="pay-co-details"><summary>${esc(titleOf(inv))} ${esc(inv.number)}</summary>${orderSummary(inv)}${parties(inv, brand)}</details>
    ${back ? `<p class="pay-co-muted" id="pay-co-countdown" data-return="${esc(back)}" role="status">Going back to ${esc(brand)} in 5 seconds.</p>
    <a class="pay-co-submit" href="${esc(back)}">Return to ${esc(brand)} now</a>` : ''}
    <div class="pay-co-foot"><span><i class="bi bi-lock" aria-hidden="true"></i> Secured by ${esc(providerLabel)}</span></div>
  </section>`;
  return publicPage(`Payment received · ${inv.number}`, body, { brand, mode, back, scripts: back ? ['../assets/checkout.js'] : [] });
}

/** An invoice that cannot be paid here (void, or nothing left to pay). */
export function closedHtml(inv, { brand, mode, pdfHref, returnUrl = null }) {
  const body = `<section class="pay-co-card pay-co-success" aria-labelledby="pay-co-closed">
    <h1 id="pay-co-closed">${esc(titleOf(inv))} ${esc(inv.number)}</h1>
    <p class="pay-co-lead">This invoice is ${esc((STATUS_WORDS[inv.status] ?? inv.status).toLowerCase())}: there is nothing to pay.</p>
    <p><a href="${esc(pdfHref)}">Download it (PDF)</a></p></section>`;
  return publicPage(`${titleOf(inv)} ${inv.number}`, body, { brand, mode, back: returnUrl });
}
