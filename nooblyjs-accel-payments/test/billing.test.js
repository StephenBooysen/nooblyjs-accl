// Accounts, catalogue, cards, subscriptions, usage, invoices and the ledger (roadmap 1.1–1.3, 2.1–2.6), offline on the
// mock provider with a clock the test moves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHost, saveCard, catalogue, HOUR, DAY } from './fixtures/host.js';

let t;
before(async () => { t = await startHost({ start: '2026-03-01T00:00:00.000Z' }); });
after(async () => { await t?.close(); });

const usageFor = (accountId, meter, hours, fromIso, services = 1) => {
  const from = Date.parse(fromIso);
  return Array.from({ length: hours }, (_, i) => ({ accountId, meter, quantity: services, at: new Date(from + i * HOUR).toISOString(), idempotencyKey: `${accountId}:${meter}:${from + i * HOUR}` }));
};

test('1.1 ensureAccount is one account per external ref, with a provider customer', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-acme', name: 'Acme', email: 'Owner@Acme.test' });
  const again = await t.pay.payments.ensureAccount({ externalRef: 'ws-acme', name: 'Other', email: 'x@y.test' });
  assert.equal(again.id, a.id);
  assert.equal(a.email, 'owner@acme.test');
  assert.equal(a.currency, 'USD');
  assert.match(a.providerCustomerRef, /^cus_mock_/);
  await assert.rejects(t.pay.payments.createAccount({ name: '', email: 'nope' }), (e) => e.status === 422 && e.details.length === 2);
});

test('1.2 the catalogue: by key, never overwritten; a used price cannot change', async () => {
  const c = await catalogue(t);
  const again = await catalogue(t);
  assert.equal(again.prices['standard-hourly'].id, c.prices['standard-hourly'].id);
  assert.equal(t.pay.billing.currentPrice('standard').unitAmount, 500);
  await assert.rejects(t.pay.billing.createPrice({ productId: c.products.standard.id, type: 'metered', unitAmount: 1, meter: 'nope' }), (e) => e.status === 422 && e.details.some((d) => d.path === 'meter'));
});

test('1.3 a card through the hosted fields: display data only; declined cards are refused at setup', async () => {
  const a = t.pay.payments.lookup('ws-acme');
  const card = await saveCard(t, a.id);
  assert.deepEqual(card.display, { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
  assert.equal(t.pay.payments.getAccount(a.id).defaultMethodId, card.id);
  await assert.rejects(saveCard(t, a.id, '4000000000000002'), (e) => e.status === 402 && /declined/.test(e.message));
  await assert.rejects(saveCard(t, a.id, '4242424242424241'), (e) => e.status === 402 && /not valid/.test(e.message));
  await assert.rejects(saveCard(t, a.id, '4242424242424242', '01/25'), (e) => e.status === 402 && /expired/.test(e.message));
});

test('2.1–2.4 a month of hourly usage closes into a numbered invoice for the monthly price, paid by the card', async () => {
  const a = t.pay.payments.lookup('ws-acme');
  const price = t.pay.billing.currentPrice('standard');
  const sub = await t.pay.billing.subscribe({ accountId: a.id, items: [{ priceId: price.id }] });
  assert.deepEqual(sub.currentPeriod, { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' });
  assert.equal(t.pay.billing.listInvoices((i) => i.accountId === a.id).length, 0, 'metered only: nothing billed in advance');
  // Two services all of March (744 hours each), recorded hour by hour; a retried batch changes nothing.
  t.clock.set('2026-03-31T23:59:00.000Z');
  await assert.rejects(t.pay.billing.recordUsage(usageFor(a.id, 'standard_hours', 1, '2026-04-02T00:00:00.000Z')), (e) => e.status === 422 && e.details[0].path === 'at');
  const events = usageFor(a.id, 'standard_hours', 744, '2026-03-01T00:00:00.000Z', 2);
  for (let i = 0; i < events.length; i += 500) await t.pay.billing.recordUsage(events.slice(i, i + 500));
  assert.deepEqual(await t.pay.billing.recordUsage(events.slice(0, 10)), { recorded: 0, duplicates: 10 });
  t.clock.set('2026-03-16T00:00:00.000Z');
  const preview = await t.pay.billing.previewInvoice(sub.id);
  assert.equal(preview.lines[0].usageQuantity, 15 * 24 * 2, 'usage so far');
  t.clock.set('2026-04-01T00:30:00.000Z');
  assert.equal(await t.pay.billing.closeDue(), 1);
  await t.pay.idle();
  const [inv] = t.pay.billing.listInvoices((i) => i.accountId === a.id);
  assert.equal(inv.number, 'INV-2026-000001');
  assert.equal(inv.status, 'paid');
  assert.equal(inv.total.amount, 1000, 'two services × $5');
  assert.equal(inv.finalizedAt, '2026-04-01T00:00:00.000Z', 'dated at the period end');
  assert.match(inv.lines[0].description, /1,488 service-hours/);
  assert.deepEqual(t.pay.billing.getSubscription(sub.id).currentPeriod, { start: '2026-04-01T00:00:00.000Z', end: '2026-05-01T00:00:00.000Z' });
  assert.equal(await t.pay.billing.closeDue(), 0, 'closing again does nothing');
  const b = t.pay.payments.ledger.balances({ accountId: a.id, currency: 'USD' });
  assert.deepEqual([b.cash, b.receivable, b.revenue], [1000, 0, -1000]);
  assert.deepEqual(t.pay.payments.ledger.unbalanced(), []);
  assert.ok(t.emails.some((e) => e.kind === 'invoice.ready' && e.invoice === 'INV-2026-000001'));
  assert.ok(t.emails.some((e) => e.kind === 'payment.succeeded' && e.data.card === 'visa ending 4242'));
  for (const type of ['pay.invoice.finalized', 'pay.payment.succeeded', 'pay.invoice.paid']) assert.ok(t.seen.some((e) => e.type === type && e.data.invoiceId === inv.id), type);
  assert.ok(t.registry.published.some((p) => p.topic === 'pay.invoice'), 'mirrored to core notifying');
});

test('2.5 VAT for a South African account (15% exclusive), with the seller\'s and buyer\'s VAT numbers', async () => {
  const za = await t.pay.payments.ensureAccount({ externalRef: 'ws-za', name: 'Kaapstad Labs', email: 'billing@kaapstad.test', country: 'ZA', taxId: '4987654321', address: { line1: '2 Long Street', city: 'Cape Town', country: 'ZA' } });
  await saveCard(t, za.id);
  const inv = await t.pay.billing.createInvoice({ accountId: za.id, lines: [{ description: 'Setup', amount: 333 }] });
  assert.deepEqual([inv.subtotal.amount, inv.tax.amount, inv.total.amount], [333, 50, 383], '49.95 → 50');
  assert.equal(inv.taxLines[0].name, 'VAT');
  assert.equal(inv.status, 'paid');
  const b = t.pay.payments.ledger.balances({ accountId: za.id, currency: 'USD' });
  assert.deepEqual([b.cash, b.revenue, b.tax_payable], [383, -333, -50]);
  const page = await t.get(`/admin/payments/p/invoices/${new URL(t.pay.payments.invoiceUrl(inv.id)).pathname.split('/').pop()}`, { roles: '' });
  assert.equal(page.status, 200);
  assert.match(page.text, /Tax invoice/);
  assert.match(page.text, /VAT number 4123456789/);
  assert.match(page.text, /VAT number 4987654321/);
  const pdf = await t.get(`/admin/billing/api/v1/invoices/${inv.id}.pdf`, { raw: true });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
  assert.ok(bytes.startsWith('%PDF-1.4') && bytes.trimEnd().endsWith('%%EOF'));
  assert.match(bytes, /\(Tax invoice\) Tj/);
  assert.match(bytes, /3\.83 USD/);
});

test('2.1 licensed items: billed in advance (prorated), changes prorated on the next invoice; credit notes; void', async () => {
  t.clock.set('2026-04-16T10:00:00.000Z');
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-seats', name: 'Seats Inc', email: 'pay@seats.test' });
  await saveCard(t, a.id);
  const seat = t.pay.billing.currentPrice('seat');
  const sub = await t.pay.billing.subscribe({ accountId: a.id, items: [{ priceId: seat.id, quantity: 1 }] });
  const first = t.pay.billing.listInvoices((i) => i.subscriptionId === sub.id)[0];
  assert.equal(first.total.amount, 500, '15 of 30 days of $10');
  assert.equal(first.status, 'paid');
  t.clock.set('2026-04-21T08:00:00.000Z');
  await t.pay.billing.updateItems(sub.id, { items: [{ priceId: seat.id, quantity: 3 }] });
  t.clock.set('2026-05-01T00:00:00.000Z');
  await t.pay.billing.closeDue();
  const second = t.pay.billing.listInvoices((i) => i.subscriptionId === sub.id && i.id !== first.id)[0];
  assert.deepEqual(second.lines.map((l) => [l.kind, l.amount.amount]), [['proration', -333], ['proration', 1000], ['licensed', 3000]], '10 of 30 days: -$3.33 + $10.00, then May × 3');
  assert.equal(second.total.amount, 3667);
  // A credit note on the paid invoice becomes account credit, used by the next invoice.
  const cn = await t.pay.billing.creditNote({ invoiceId: second.id, amount: 667, reason: 'Goodwill for the outage' });
  assert.equal(cn.number, 'CN-2026-000001');
  assert.equal(t.pay.payments.getAccount(a.id).creditBalance.amount, 667);
  const third = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Extra', amount: 1000 }] });
  assert.deepEqual([third.creditApplied.amount, third.amountDue.amount, third.status], [667, 333, 'paid']);
  assert.equal(t.pay.payments.getAccount(a.id).creditBalance.amount, 0);
  // A credit note with a refund goes back to the card.
  const cn2 = await t.pay.billing.creditNote({ invoiceId: second.id, amount: 1000, reason: 'Refund one seat', refund: true });
  assert.ok(cn2.refundId);
  assert.equal(t.pay.payments.getAccount(a.id).creditBalance.amount, 0);
  // Void: an unpaid invoice (collection paused) reverses its postings.
  await t.pay.billing.pause(sub.id);
  const drafted = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Later', amount: 200 }], finalize: false });
  const voided = await t.pay.billing.voidInvoice(drafted.id);
  assert.equal(voided.status, 'void');
  await assert.rejects(t.pay.billing.voidInvoice(second.id), (e) => e.status === 409);
  assert.deepEqual(t.pay.payments.ledger.unbalanced(), []);
  const bal = t.pay.payments.ledger.balances({ accountId: a.id, currency: 'USD' });
  assert.equal(bal.receivable, 0);
  assert.equal(bal.customer_credit, 0);
});

test('2.1 cancel at period end and now; trial', async () => {
  t.clock.set('2026-05-10T00:00:00.000Z');
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-trial', name: 'Trial Co', email: 'pay@trial.test' });
  await saveCard(t, a.id);
  const seat = t.pay.billing.currentPrice('seat');
  const sub = await t.pay.billing.subscribe({ accountId: a.id, items: [{ priceId: seat.id }], trialDays: 14 });
  assert.equal(sub.status, 'trialing');
  assert.equal(t.pay.billing.listInvoices((i) => i.subscriptionId === sub.id).length, 0);
  t.clock.set('2026-05-24T01:00:00.000Z');
  await t.pay.billing.closeDue();
  const s = t.pay.billing.getSubscription(sub.id);
  assert.equal(s.status, 'active');
  assert.equal(t.pay.billing.listInvoices((i) => i.subscriptionId === sub.id)[0].total.amount, 258, '8 of 31 days of May');
  await t.pay.billing.cancel(sub.id, { atPeriodEnd: true });
  t.clock.set('2026-06-01T00:00:01.000Z');
  await t.pay.billing.closeDue();
  assert.equal(t.pay.billing.getSubscription(sub.id).status, 'cancelled');
  assert.ok(t.seen.some((e) => e.type === 'pay.subscription.cancelled' && e.data.subscriptionId === sub.id));
});
