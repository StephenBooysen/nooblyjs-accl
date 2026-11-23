// BillingSummary (spec §9): the next invoice as it stands, saved cards and invoices for one account, from the summary
// the host's API passes through (pay.billing.summary(accountId)). No framework; the host styles the pay-* classes with
// its theme, and gives the buttons their behaviour.
//
//   import { renderBillingSummary } from '/admin/payments/components/billing-summary.js';
//   renderBillingSummary(el, summary, { sections: ['upcoming', 'invoices'], onPay: (invoice) => … });

const EXP = { JPY: 0, KRW: 0, BHD: 3, KWD: 3, OMR: 3 };
const STATUS = { draft: 'Draft', open: 'Open', paid: 'Paid', void: 'Void', uncollectible: 'Unpaid' };

/** "$1,234.50" from integer minor units (no float arithmetic). */
export function formatMoney(m) {
  if (!m) return '';
  const exp = EXP[m.currency] ?? 2;
  const digits = String(Math.abs(m.amount)).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let symbol = `${m.currency} `;
  try {
    symbol = new Intl.NumberFormat('en', { style: 'currency', currency: m.currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? symbol;
  } catch { /* the code */ }
  if (/^[A-Za-z]+$/.test(symbol)) symbol = `${symbol} `;
  return `${m.amount < 0 ? '-' : ''}${symbol}${exp ? `${whole}.${digits.slice(-exp)}` : whole}`;
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const periodText = (p) => (p ? `${day(p.start)} – ${day(new Date(Date.parse(p.end) - 1).toISOString())}` : '');

function h(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

/**
 * @param {HTMLElement} root
 * @param {object} summary   pay.billing.summary()
 * @param {{ sections?: string[], onPay?: (invoice) => void, onMakeDefault?: (card) => void, onRemove?: (card) => void, invoiceHref?: (invoice) => string, pdfHref?: (invoice) => string }} [o]
 */
export function renderBillingSummary(root, summary, { sections = ['upcoming', 'methods', 'invoices'], onPay, onMakeDefault, onRemove, invoiceHref = (i) => i.url, pdfHref = (i) => (i.url ? `${i.url}/pdf` : null), headingLevel = 2 } = {}) {
  const doc = root.ownerDocument;
  const H = `h${headingLevel}`;
  const out = [];

  if (sections.includes('upcoming')) {
    const up = summary.upcoming;
    const sec = h(doc, 'section', { class: 'pay-summary-upcoming', 'aria-labelledby': 'pay-upcoming-title' }, h(doc, H, { id: 'pay-upcoming-title' }, 'Next invoice'));
    if (!up) sec.append(h(doc, 'p', { class: 'pay-summary-empty' }, 'No subscription yet.'));
    else {
      sec.append(h(doc, 'p', { class: 'pay-summary-period' }, `This period: ${periodText(up.period)} (so far, as of ${day(up.asOf)})`));
      const rows = up.lines.length
        ? up.lines.map((l) => h(doc, 'tr', {}, h(doc, 'td', {}, l.description), h(doc, 'td', { class: 'pay-num' }, formatMoney(l.amount))))
        : [h(doc, 'tr', {}, h(doc, 'td', { colspan: '2', class: 'pay-summary-empty' }, 'Nothing to pay for yet this period.'))];
      const foot = [h(doc, 'tr', {}, h(doc, 'td', {}, 'Subtotal'), h(doc, 'td', { class: 'pay-num' }, formatMoney(up.subtotal)))];
      for (const t of up.taxLines ?? []) foot.push(h(doc, 'tr', {}, h(doc, 'td', {}, `${t.name} ${t.rate / 100}%${t.inclusive ? ' (included)' : ''}`), h(doc, 'td', { class: 'pay-num' }, formatMoney(t.amount))));
      if (up.creditApplied?.amount) foot.push(h(doc, 'tr', {}, h(doc, 'td', {}, 'Account credit'), h(doc, 'td', { class: 'pay-num' }, `-${formatMoney(up.creditApplied)}`)));
      foot.push(h(doc, 'tr', { class: 'pay-total' }, h(doc, 'td', {}, 'Due so far'), h(doc, 'td', { class: 'pay-num' }, formatMoney(up.amountDue))));
      sec.append(h(doc, 'table', { class: 'pay-summary-table' },
        h(doc, 'thead', {}, h(doc, 'tr', {}, h(doc, 'th', { scope: 'col' }, 'Item'), h(doc, 'th', { scope: 'col', class: 'pay-num' }, 'Amount'))),
        h(doc, 'tbody', {}, rows), h(doc, 'tfoot', {}, foot)));
    }
    out.push(sec);
  }

  if (sections.includes('methods')) {
    const sec = h(doc, 'section', { class: 'pay-summary-methods', 'aria-labelledby': 'pay-methods-title' }, h(doc, H, { id: 'pay-methods-title' }, 'Cards'));
    if (!summary.methods.length) sec.append(h(doc, 'p', { class: 'pay-summary-empty' }, 'No card on file.'));
    else sec.append(h(doc, 'ul', { class: 'pay-summary-cards' }, summary.methods.map((m) => h(doc, 'li', {},
      h(doc, 'span', { class: 'pay-card-brand' }, `${m.brand[0].toUpperCase()}${m.brand.slice(1)} ending ${m.last4}`),
      h(doc, 'span', { class: 'pay-card-exp' }, ` expires ${String(m.expMonth).padStart(2, '0')}/${m.expYear}`),
      m.isDefault ? h(doc, 'span', { class: 'pay-pill pay-pill-default' }, 'Default') : null,
      !m.isDefault && onMakeDefault ? h(doc, 'button', { type: 'button', class: 'pay-link', onclick: () => onMakeDefault(m) }, 'Make default') : null,
      onRemove ? h(doc, 'button', { type: 'button', class: 'pay-link', 'aria-label': `Remove the card ending ${m.last4}`, onclick: () => onRemove(m) }, 'Remove') : null))));
    out.push(sec);
  }

  if (sections.includes('invoices')) {
    const sec = h(doc, 'section', { class: 'pay-summary-invoices', 'aria-labelledby': 'pay-invoices-title' }, h(doc, H, { id: 'pay-invoices-title' }, 'Invoices'));
    if (!summary.invoices.length) sec.append(h(doc, 'p', { class: 'pay-summary-empty' }, 'No invoices yet.'));
    else sec.append(h(doc, 'table', { class: 'pay-summary-table' },
      h(doc, 'thead', {}, h(doc, 'tr', {}, ...['Invoice', 'Period', 'Total', 'Status', ''].map((t, i) => h(doc, 'th', { scope: 'col', class: i === 2 ? 'pay-num' : null }, t)))),
      h(doc, 'tbody', {}, summary.invoices.map((inv) => h(doc, 'tr', {},
        h(doc, 'td', {}, invoiceHref(inv) ? h(doc, 'a', { href: invoiceHref(inv), target: '_blank', rel: 'noopener' }, inv.number) : inv.number),
        h(doc, 'td', {}, inv.period ? periodText(inv.period) : day(inv.finalizedAt)),
        h(doc, 'td', { class: 'pay-num' }, formatMoney(inv.total)),
        h(doc, 'td', {}, h(doc, 'span', { class: `pay-pill pay-pill-${inv.status}${inv.status === 'open' && inv.attempts ? ' pay-pill-overdue' : ''}` }, inv.status === 'open' && inv.attempts ? 'Overdue' : STATUS[inv.status] ?? inv.status)),
        h(doc, 'td', { class: 'pay-summary-actions' },
          pdfHref(inv) ? h(doc, 'a', { href: pdfHref(inv), target: '_blank', rel: 'noopener', 'aria-label': `PDF of invoice ${inv.number}` }, 'PDF') : null,
          onPay && ['open', 'uncollectible'].includes(inv.status) ? h(doc, 'button', { type: 'button', class: 'pay-link', onclick: () => onPay(inv) }, `Pay ${formatMoney(inv.amountRemaining)}`) : null))))));
    out.push(sec);
  }
  root.replaceChildren(...out);
}
