// The hosted checkout and receipt (the *Hosted checkout* and *Payment success* mock-ups), payment links, refund reasons
// and receipts, and what the Setup screens read: on the mock provider, with the test clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHost, saveCard, catalogue } from './fixtures/host.js';

let t;
before(async () => {
  t = await startHost({ start: '2026-07-01T00:00:00.000Z', dunning: { retryDays: [1, 3, 5, 7] } });
  await catalogue(t);
});
after(async () => { await t?.close(); });

const pathOf = (url) => new URL(url).pathname;
/** Types a card into the mock hosted fields for a checkout setup, as the frame does. */
async function typeCard(setup, number) {
  const secret = new URL(setup.fieldsUrl).searchParams.get('secret');
  const res = await t.post('/admin/payments/p/mock/setups', { roles: '', body: { secret, number, exp: '12/30', cvc: '123' } });
  assert.equal(res.status, 200, res.text);
}
/** Pays an invoice on its checkout page with a card. */
async function payOnCheckout(page, number, { save = true } = {}) {
  const setup = await t.post(`${page}/setup`, { roles: '', body: {} });
  assert.equal(setup.status, 201, setup.text);
  await typeCard(setup.json, number);
  const paid = await t.post(`${page}/pay`, { roles: '', body: { setupId: setup.json.setupId, save } });
  assert.equal(paid.status, 200, paid.text);
  return paid.json;
}
const noInlineCode = (html) => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=|<style/, 'no inline style');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline handlers');
};

test('a payment link: the invoice is emailed with the checkout link, not charged; the checkout pays it with a new card after a decline', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-link', name: 'Link Co', email: 'owner@link.test' });
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Set-up and migration', amount: 48000 }], collect: false });
  assert.equal(inv.status, 'open');
  assert.equal(t.pay.payments.listPayments((p) => p.invoiceId === inv.id).length, 0, 'not charged');
  const mail = t.emails.find((e) => e.kind === 'invoice.payment_link' && e.invoice === inv.number);
  assert.ok(mail, 'the payment link is emailed');
  assert.match(mail.data.url, /\/admin\/payments\/p\/invoices\//);

  const page = pathOf(t.pay.payments.invoiceUrl(inv.id));
  const html = (await t.get(page, { roles: '' })).text;
  assert.match(html, /Pay Test Cloud/);
  assert.match(html, /\$480\.00/);
  assert.match(html, /Set-up and migration/);
  assert.match(html, /id="pay-checkout"/);
  assert.match(html, /Save this card with Test Cloud/);
  assert.match(html, /Test mode/);
  noInlineCode(html);

  // A card that saves but declines: the answer says so; the customer's own attempt is not a dunning attempt.
  const declined = await payOnCheckout(page, '4000000000000341');
  assert.equal(declined.status, 'failed');
  assert.match(declined.message, /declined/i);
  assert.equal(t.pay.billing.getInvoice(inv.id).status, 'open');
  assert.equal(t.pay.billing.getInvoice(inv.id).attempts ?? 0, 0);
  assert.match((await t.get(page, { roles: '' })).text, /id="pay-checkout"/, 'still payable');

  // A good card pays it with one charge.
  const ok = await payOnCheckout(page, '4242424242424242');
  assert.equal(ok.status, 'paid');
  const charges = t.pay.payments.listPayments((p) => p.invoiceId === inv.id);
  assert.deepEqual(charges.map((p) => p.status).sort(), ['failed', 'succeeded']);
  const account = t.pay.payments.getAccount(a.id);
  const def = t.pay.payments.listMethods(a.id).find((m) => m.id === account.defaultMethodId);
  assert.equal(def.display.last4, '4242', 'saved as the default');

  // The receipt, and back to the host's own page only.
  const back = await t.get(`${page}?return=${encodeURIComponent('/w/link/billing')}`, { roles: '' });
  assert.match(back.text, /Payment received/);
  assert.match(back.text, /Visa ·· 4242/);
  assert.match(back.text, new RegExp(`data-return="http://cloud.test/w/link/billing\\?payment=succeeded&amp;invoice=${inv.number}"`));
  noInlineCode(back.text);
  const evil = await t.get(`${page}?return=${encodeURIComponent('https://evil.test/x')}`, { roles: '' });
  assert.doesNotMatch(evil.text, /evil\.test/);
  const sneaky = await t.get(`${page}?return=${encodeURIComponent('//evil.test/x')}`, { roles: '' });
  assert.doesNotMatch(sneaky.text, /evil\.test/);
  // A paid invoice cannot be set up again.
  assert.equal((await t.post(`${page}/setup`, { roles: '', body: {} })).status, 409);
});

test('an overdue invoice: the new default card pays it through the overdue retry, charged once', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-overdue', name: 'Overdue Co', email: 'owner@overdue.test' });
  await saveCard(t, a.id, '4000000000000341');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Support', amount: 2900 }] });
  assert.equal(t.pay.billing.getInvoice(inv.id).attempts, 1, 'the automatic charge failed');
  const page = pathOf(t.pay.payments.invoiceUrl(inv.id));
  assert.match((await t.get(page, { roles: '' })).text, /The last attempt to charge the card failed; we try again on/);
  const out = await payOnCheckout(page, '4242424242424242');
  assert.equal(out.status, 'paid');
  assert.deepEqual(t.pay.payments.listPayments((p) => p.invoiceId === inv.id).map((p) => p.status).sort(), ['failed', 'succeeded']);
});

test('the checkout without saving: the card pays this invoice and is removed; the default card stays', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-once', name: 'Once Co', email: 'owner@once.test' });
  const saved = await saveCard(t, a.id, '5555555555554444');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Workshop', amount: 9900 }], collect: false });
  const page = pathOf(t.pay.payments.invoiceUrl(inv.id));
  const out = await payOnCheckout(page, '4242424242424242', { save: false });
  assert.equal(out.status, 'paid');
  const paidWith = t.pay.payments.listPayments((p) => p.invoiceId === inv.id && p.status === 'succeeded')[0];
  assert.notEqual(paidWith.methodId, saved.id, 'paid with the new card');
  assert.deepEqual(t.pay.payments.listMethods(a.id).map((m) => m.display.last4), ['4444'], 'the new card is not kept');
  assert.equal(t.pay.payments.getAccount(a.id).defaultMethodId, saved.id);
  assert.equal((await t.get('/admin/payments/p/invoices/not-a-token', { roles: '' })).status, 404);
});

test('refunds carry the provider reason and, when asked, email the customer a receipt', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-reason', name: 'Reason Co', email: 'owner@reason.test' });
  await saveCard(t, a.id);
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Order', amount: 4800 }] });
  const payment = t.pay.payments.listPayments((p) => p.invoiceId === inv.id && p.status === 'succeeded')[0];
  const bad = await t.post('/admin/payments/api/v1/refunds', { roles: 'finance', headers: { 'idempotency-key': 'refund-reason-0001' }, body: { paymentId: payment.id, amount: 1000, reason: 'Broken', reasonCode: 'because' } });
  assert.equal(bad.status, 422);
  const quiet = await t.post('/admin/payments/api/v1/refunds', { roles: 'finance', headers: { 'idempotency-key': 'refund-reason-0002' }, body: { paymentId: payment.id, amount: 1000, reason: 'One item broken', reasonCode: 'requested_by_customer' } });
  assert.equal(quiet.status, 201);
  assert.equal(quiet.json.reasonCode, 'requested_by_customer');
  assert.equal(t.emails.filter((e) => e.kind === 'refund.succeeded').length, 0, 'no receipt unless asked');
  const told = await t.post('/admin/payments/api/v1/refunds', { roles: 'finance', headers: { 'idempotency-key': 'refund-reason-0003' }, body: { paymentId: payment.id, amount: 1800, reason: 'Duplicate', reasonCode: 'duplicate', notifyCustomer: true } });
  assert.equal(told.status, 201);
  const receipt = t.emails.find((e) => e.kind === 'refund.succeeded');
  assert.equal(receipt.to, 'owner@reason.test');
  assert.equal(receipt.data.refund.amount, '$18.00');
  assert.match(receipt.data.card, /4242/);
  const detail = await t.get(`/admin/payments/api/v1/payments/${payment.id}`);
  assert.equal(detail.json.refunds.length, 2);
  assert.equal(detail.json.method.last4, '4242', 'the card is on the payment for the order screen');
});

test('Setup reads the provider: mode, account, the webhook endpoint and the events to send', async () => {
  const p = await t.get('/admin/payments/api/v1/provider', { roles: 'support' });
  assert.equal(p.status, 200);
  assert.equal(p.json.name, 'mock');
  assert.equal(p.json.mode, 'test');
  assert.equal(p.json.brand, 'Test Cloud');
  assert.equal(p.json.webhookUrl, 'http://cloud.test/admin/payments/p/webhooks/mock');
  assert.ok(p.json.webhookEvents.includes('charge.succeeded'));
  assert.equal((await t.get('/admin/payments/api/v1/provider', { roles: '' })).status, 403);
});
