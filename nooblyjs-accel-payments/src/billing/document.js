// Invoices as documents (roadmap 2.7, 3.6): HTML (the hosted invoice page and the operator view) and PDF from a small
// dependency-free writer (decided in Phase 3: text on A4 pages with the standard Helvetica fonts, no images). A South
// African VAT invoice (O4) needs the words "Tax invoice", the seller's and (when given) the buyer's VAT numbers, a
// sequential number, the date, and the VAT amount: all on both.
import { format } from '../shared/money.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const periodText = (p) => (p ? `${day(p.start)} to ${day(new Date(Date.parse(p.end) - 1).toISOString())}` : '');
const addressLines = (a) => (a ? [a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean) : []);

export const STATUS_WORDS = { draft: 'Draft', open: 'Open', paid: 'Paid', void: 'Void', uncollectible: 'Uncollectible' };

export function titleOf(inv) {
  return inv.taxLines?.length && inv.seller?.taxId ? 'Tax invoice' : 'Invoice';
}

/**
 * The invoice as a page (no inline style or script: the stylesheet is `cssHref`).
 * @param {object} inv
 * @param {{ brand: string, cssHref: string, pdfHref?: string, payHref?: string, notice?: string }} o
 */
export function invoiceHtml(inv, { brand, cssHref, pdfHref = null, payHref = null, notice = null }) {
  const seller = inv.seller ?? { name: brand };
  const b = inv.billingDetails ?? {};
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}${l.period ? `<div class="pay-muted">${esc(periodText(l.period))}</div>` : ''}</td><td class="pay-num">${esc(format(l.amount))}</td></tr>`).join('');
  const taxRows = (inv.taxLines ?? []).map((t) => `<tr><td>${esc(t.name)} ${t.rate / 100}%${t.inclusive ? ' (included)' : ''}</td><td class="pay-num">${esc(format(t.amount))}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleOf(inv))} ${esc(inv.number ?? 'draft')} · ${esc(seller.name)}</title>
<link rel="stylesheet" href="${esc(cssHref)}"></head>
<body class="pay-doc"><main class="pay-invoice" aria-labelledby="pay-title">
<header class="pay-invoice-head">
  <div><h1 id="pay-title">${esc(titleOf(inv))}</h1><p class="pay-number">${esc(inv.number ?? 'Draft')}</p>
  <p class="pay-status pay-status-${esc(inv.status)}">${esc(STATUS_WORDS[inv.status] ?? inv.status)}</p></div>
  <div class="pay-seller"><strong>${esc(seller.name)}</strong>${addressLines(seller.address).map((l) => `<br>${esc(l)}`).join('')}${seller.taxId ? `<br>VAT number ${esc(seller.taxId)}` : ''}${seller.email ? `<br>${esc(seller.email)}` : ''}</div>
</header>
${notice ? `<p class="pay-notice" role="status">${esc(notice)}</p>` : ''}
<section class="pay-parties">
  <div><h2>Billed to</h2><p><strong>${esc(b.name)}</strong><br>${esc(b.email)}${addressLines(b.address).map((l) => `<br>${esc(l)}`).join('')}${b.taxId ? `<br>VAT number ${esc(b.taxId)}` : ''}</p></div>
  <div><h2>Details</h2><dl><dt>Date</dt><dd>${esc(day(inv.finalizedAt ?? inv.issuedAt))}</dd>${inv.period ? `<dt>Period</dt><dd>${esc(periodText(inv.period))}</dd>` : ''}${inv.paidAt ? `<dt>Paid</dt><dd>${esc(day(inv.paidAt))}</dd>` : ''}</dl></div>
</section>
<table class="pay-lines"><caption class="pay-visually-hidden">Lines</caption><thead><tr><th scope="col">Description</th><th scope="col" class="pay-num">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td>Subtotal</td><td class="pay-num">${esc(format(inv.subtotal))}</td></tr>${taxRows}
<tr class="pay-total"><td>Total</td><td class="pay-num">${esc(format(inv.total))}</td></tr>
${inv.creditApplied?.amount ? `<tr><td>Account credit applied</td><td class="pay-num">-${esc(format(inv.creditApplied))}</td></tr>` : ''}
${inv.credited?.amount ? `<tr><td>Credit notes</td><td class="pay-num">-${esc(format(inv.credited))}</td></tr>` : ''}
${inv.amountPaid?.amount ? `<tr><td>Paid</td><td class="pay-num">-${esc(format(inv.amountPaid))}</td></tr>` : ''}
<tr class="pay-total"><td>Amount due</td><td class="pay-num">${esc(format(inv.amountRemaining ?? inv.amountDue))}</td></tr></tfoot></table>
<p class="pay-actions">${pdfHref ? `<a href="${esc(pdfHref)}">Download PDF</a>` : ''}${payHref ? ` <a class="pay-button" href="${esc(payHref)}">Pay this invoice</a>` : ''}</p>
</main></body></html>`;
}

// ---- PDF -----------------------------------------------------------------------------------------------------------

/** Helvetica advance widths (per 1000) for the characters invoices use most; others count as 556. */
const WIDTHS = { ' ': 278, ',': 278, '.': 278, '-': 333, '(': 333, ')': 333, '/': 278, ':': 278, '%': 889, '$': 556, I: 278, i: 222, l: 222, j: 222, t: 278, f: 278, r: 333, m: 833, w: 722, M: 833, W: 944, U: 722, S: 667, D: 722, A: 667, R: 722, N: 722, O: 778, C: 722, Z: 611, E: 667 };
const widthOf = (text, size) => [...text].reduce((w, c) => w + (WIDTHS[c] ?? 556), 0) * size / 1000;

/** Latin-1 only (WinAnsi), with PDF string escapes. */
const pdfText = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);

function pdfDocument(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const ops of pages) {
    const content = Buffer.from(ops.join('\n'), 'latin1');
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The invoice as a PDF (A4), amounts with ISO codes so every currency prints in the standard fonts. */
export function invoicePdf(inv, { brand }) {
  const seller = inv.seller ?? { name: brand };
  const b = inv.billingDetails ?? {};
  const m = (x) => format(x, { code: true });
  const pages = [];
  let ops = [];
  let y = 800;
  const text = (x, yy, s, { size = 10, boldFont = false, right = false } = {}) => {
    const t = pdfText(s);
    const xx = right ? x - widthOf(String(s), size) : x;
    ops.push(`BT /${boldFont ? 'F2' : 'F1'} ${size} Tf ${xx.toFixed(2)} ${yy.toFixed(2)} Td (${t}) Tj ET`);
  };
  const rule = (yy) => ops.push(`0.8 w 50 ${yy} m 545 ${yy} l S`);
  const newPage = () => { pages.push(ops); ops = []; y = 800; };

  text(50, y, titleOf(inv), { size: 20, boldFont: true });
  text(545, y, seller.name, { boldFont: true, right: true });
  y -= 18;
  text(50, y, `${inv.number ?? 'Draft'} · ${STATUS_WORDS[inv.status] ?? inv.status}`, { size: 11 });
  let sy = y;
  for (const l of [...addressLines(seller.address), ...(seller.taxId ? [`VAT number ${seller.taxId}`] : []), ...(seller.email ? [seller.email] : [])]) { text(545, sy, l, { right: true }); sy -= 13; }
  y = Math.min(y, sy) - 24;
  text(50, y, 'Billed to', { boldFont: true });
  text(330, y, 'Details', { boldFont: true });
  y -= 14;
  const billed = [b.name, b.email, ...addressLines(b.address), ...(b.taxId ? [`VAT number ${b.taxId}`] : [])].filter(Boolean);
  const details = [`Date ${day(inv.finalizedAt ?? inv.issuedAt)}`, ...(inv.period ? [`Period ${periodText(inv.period)}`] : []), ...(inv.paidAt ? [`Paid ${day(inv.paidAt)}`] : [])];
  for (let i = 0; i < Math.max(billed.length, details.length); i += 1) {
    if (billed[i]) text(50, y, billed[i]);
    if (details[i]) text(330, y, details[i]);
    y -= 13;
  }
  y -= 16;
  text(50, y, 'Description', { boldFont: true });
  text(545, y, 'Amount', { boldFont: true, right: true });
  y -= 6;
  rule(y);
  y -= 16;
  for (const l of inv.lines) {
    if (y < 120) newPage();
    text(50, y, l.description.length > 80 ? `${l.description.slice(0, 77)}...` : l.description);
    text(545, y, m(l.amount), { right: true });
    if (l.period) { y -= 12; text(50, y, periodText(l.period), { size: 8 }); }
    y -= 16;
  }
  if (y < 160) newPage();
  rule(y + 8);
  const total = (label, value, boldFont = false) => { text(380, y, label, { boldFont }); text(545, y, value, { right: true, boldFont }); y -= 15; };
  total('Subtotal', m(inv.subtotal));
  for (const t of inv.taxLines ?? []) total(`${t.name} ${t.rate / 100}%${t.inclusive ? ' (included)' : ''}`, m(t.amount));
  total('Total', m(inv.total), true);
  if (inv.creditApplied?.amount) total('Account credit applied', `-${m(inv.creditApplied)}`);
  if (inv.credited?.amount) total('Credit notes', `-${m(inv.credited)}`);
  if (inv.amountPaid?.amount) total('Paid', `-${m(inv.amountPaid)}`);
  total('Amount due', m(inv.amountRemaining ?? inv.amountDue), true);
  pages.push(ops);
  return pdfDocument(pages);
}
