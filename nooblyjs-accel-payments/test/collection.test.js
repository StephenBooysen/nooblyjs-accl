// Collection, dunning, 3-D Secure, refunds and webhooks (roadmap 3.1–3.4), with a clock the test moves and the mock
// provider's test cards, failure injection and out-of-band events.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHost, saveCard, catalogue, DAY } from './fixtures/host.js';

let t;
before(async () => {
  t = await startHost({ start: '2026-06-01T00:00:00.000Z', dunning: { retryDays: [1, 3, 5, 7] } });
  await catalogue(t);
});
after(async () => { await t?.close(); });

test('3.2 a declining card is retried on schedule, the owner is emailed each time, then the account is delinquent; a new card pays and reinstates it', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-decline', name: 'Decline Co', email: 'owner@decline.test' });
  await saveCard(t, a.id, '4000000000000341');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'June', amount: 2000 }] });
  assert.equal(inv.status, 'open');
  assert.equal(inv.attempts, 1);
  assert.equal(inv.nextAttemptAt, '2026-06-02T00:00:00.000Z');
  const failed = () => t.emails.filter((e) => e.kind === 'payment.failed' && e.invoice === inv.number);
  assert.equal(failed().length, 1);
  assert.match(failed()[0].data.next, /try again on/);
  for (const [dayN, attempts] of [[1, 2], [3, 3], [5, 4]]) {
    t.clock.set(Date.parse('2026-06-01T00:00:00.000Z') + dayN * DAY + 1000);
    await t.pay.tick();
    assert.equal(t.pay.billing.getInvoice(inv.id).attempts, attempts, `day ${dayN}`);
  }
  assert.equal(failed().length, 4);
  assert.equal(t.pay.payments.getAccount(a.id).status, 'active');
  t.clock.set(Date.parse('2026-06-01T00:00:00.000Z') + 7 * DAY + 1000);
  await t.pay.tick();
  const last = t.pay.billing.getInvoice(inv.id);
  assert.deepEqual([last.attempts, last.status, last.nextAttemptAt], [5, 'uncollectible', null]);
  assert.equal(failed().length, 5);
  assert.match(failed()[4].data.next, /last attempt/);
  assert.equal(t.pay.payments.getAccount(a.id).status, 'delinquent');
  assert.ok(t.seen.some((e) => e.type === 'pay.account.delinquent' && e.data.externalRef === 'ws-decline'));
  assert.ok(t.emails.some((e) => e.kind === 'account.delinquent'));
  assert.equal(t.pay.payments.ledger.balances({ accountId: a.id }).bad_debt, 2000);
  // A working card: the written-off invoice is paid straight away and the account is reinstated.
  await saveCard(t, a.id, '4242424242424242');
  await t.pay.idle();
  assert.equal(t.pay.billing.getInvoice(inv.id).status, 'paid');
  assert.equal(t.pay.payments.getAccount(a.id).status, 'active');
  assert.ok(t.seen.some((e) => e.type === 'pay.account.reinstated' && e.data.accountId === a.id));
  const b = t.pay.payments.ledger.balances({ accountId: a.id });
  assert.deepEqual([b.bad_debt, b.receivable, b.cash], [0, 0, 2000]);
});

test('3.1 3-D Secure: the payment waits for the cardholder; the hand-off page completes it', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-3ds', name: 'Secure Co', email: 'owner@secure.test' });
  await saveCard(t, a.id, '4000002760003184');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Usage', amount: 1500 }] });
  assert.equal(inv.status, 'open');
  const payment = t.pay.payments.listPayments((p) => p.invoiceId === inv.id)[0];
  assert.equal(payment.status, 'requires_action');
  const notice = t.emails.find((e) => e.kind === 'payment.action_required' && e.invoice === inv.number);
  assert.ok(notice, 'the confirm email');
  assert.ok(!t.emails.some((e) => e.kind === 'payment.failed' && e.invoice === inv.number), 'not also a failure email');
  const path = new URL(notice.data.url).pathname;
  const page = await t.get(path, { roles: '' });
  assert.equal(page.status, 200);
  assert.match(page.text, /Confirm the payment/);
  assert.doesNotMatch(page.text, /<script>|onclick=|style="/, 'no inline code');
  const done = await t.post(`${path}/complete`, { roles: '', body: 'result=succeed', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(done.status, 303);
  await t.pay.idle();
  assert.equal(t.pay.billing.getInvoice(inv.id).status, 'paid');
  assert.match((await t.get(path, { roles: '' })).text, /Payment confirmed/);
  assert.equal((await t.get(`${path.slice(0, -4)}xxxx`, { roles: '' })).status, 404, 'a tampered token');
});

test('3.3 refunds: partial and full, the support limit, and an idempotent replay', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-refund', name: 'Refund Co', email: 'owner@refund.test' });
  await saveCard(t, a.id);
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'Annual', amount: 12000 }] });
  const payment = t.pay.payments.listPayments((p) => p.invoiceId === inv.id && p.status === 'succeeded')[0];
  const key = { 'idempotency-key': 'refund-key-0001' };
  const big = await t.post('/admin/payments/api/v1/refunds', { roles: 'support', headers: key, body: { paymentId: payment.id, amount: 6000, reason: 'Asked nicely' } });
  assert.equal(big.status, 403);
  assert.match(big.json.error.message, /need finance/);
  const small = await t.post('/admin/payments/api/v1/refunds', { roles: 'support', headers: { 'idempotency-key': 'refund-key-0002' }, body: { paymentId: payment.id, amount: 2000, reason: 'Downtime' } });
  assert.equal(small.status, 201);
  const replay = await t.post('/admin/payments/api/v1/refunds', { roles: 'support', headers: { 'idempotency-key': 'refund-key-0002' }, body: { paymentId: payment.id, amount: 2000, reason: 'Downtime' } });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.json.id, small.json.id);
  const reused = await t.post('/admin/payments/api/v1/refunds', { roles: 'support', headers: { 'idempotency-key': 'refund-key-0002' }, body: { paymentId: payment.id, amount: 1000, reason: 'Downtime' } });
  assert.equal(reused.status, 422);
  assert.equal((await t.post('/admin/payments/api/v1/refunds', { roles: 'finance', body: { paymentId: payment.id, reason: 'x y z' } })).status, 422, 'no Idempotency-Key');
  const rest = await t.post('/admin/payments/api/v1/refunds', { roles: 'finance', headers: { 'idempotency-key': 'refund-key-0003' }, body: { paymentId: payment.id, reason: 'Cancelled the year' } });
  assert.equal(rest.json.amount.amount, 10000);
  assert.equal(t.pay.payments.listRefunds((r) => r.paymentId === payment.id).length, 2);
  const b = t.pay.payments.ledger.balances({ accountId: a.id });
  assert.deepEqual([b.cash, b.refunds], [0, 12000]);
  assert.ok(t.pay.audit.list({ action: 'refund.refused' }).length >= 1, 'the refusal is audited');
});

test('3.4 webhooks: the signature is checked on the raw body, events are de-duplicated, a refund made on the dashboard is recorded and flagged', async () => {
  const a = t.pay.payments.lookup('ws-refund');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'More', amount: 3000 }] });
  const payment = t.pay.payments.listPayments((p) => p.invoiceId === inv.id && p.status === 'succeeded')[0];
  // Forged and stale bodies are refused.
  const body = JSON.stringify({ id: 'evt_forged', type: 'refund.succeeded', data: {} });
  assert.equal((await t.post('/admin/payments/p/webhooks/mock', { roles: '', body, headers: { 'mock-signature': 't=1,v1=00' } })).status, 400);
  assert.equal((await t.post('/admin/payments/p/webhooks/stripe', { roles: '', body, headers: t.pay.mock.sign(body) })).status, 404, 'not this provider');
  // An out-of-band refund arrives as a provider event.
  await t.pay.mock.refundOutOfBand(payment.providerRef, 500);
  await t.pay.idle();
  const outside = t.pay.payments.listRefunds((r) => r.paymentId === payment.id)[0];
  assert.deepEqual([outside.source, outside.amount.amount], ['provider', 500]);
  const issue = t.pay.payments.listIssues((i) => i.kind === 'refund_outside')[0];
  assert.ok(issue);
  // The same event delivered twice is processed once.
  const again = JSON.stringify({ id: 'evt_twice', type: 'dispute.created', created: 0, data: { chargeRef: payment.providerRef, amount: { amount: 3000, currency: 'USD' }, reason: 'fraudulent' } });
  const first = await t.post('/admin/payments/p/webhooks/mock', { roles: '', body: again, headers: { 'content-type': 'application/json', ...t.pay.mock.sign(again) } });
  const second = await t.post('/admin/payments/p/webhooks/mock', { roles: '', body: again, headers: { 'content-type': 'application/json', ...t.pay.mock.sign(again) } });
  assert.deepEqual([first.json.duplicate, second.json.duplicate], [false, true]);
  await t.pay.idle();
  assert.equal(t.pay.payments.listIssues((i) => i.kind === 'dispute').length, 1);
  const resolved = await t.post(`/admin/payments/api/v1/reconciliation/issues/${issue.id}:resolve`, { roles: 'finance', body: {} });
  assert.equal(resolved.json.status, 'resolved');
  assert.deepEqual(t.pay.payments.ledger.unbalanced(), []);
});

test('3.1 the provider unavailable: the attempt fails and is retried; failure injection is once', async () => {
  const a = await t.pay.payments.ensureAccount({ externalRef: 'ws-flaky', name: 'Flaky Co', email: 'owner@flaky.test' });
  await saveCard(t, a.id);
  t.pay.mock.inject('charge', 'unavailable');
  const inv = await t.pay.billing.createInvoice({ accountId: a.id, lines: [{ description: 'June', amount: 700 }] });
  assert.equal(inv.status, 'open');
  assert.equal(inv.lastFailure.code, 'unavailable');
  t.clock.set(Date.parse(inv.nextAttemptAt) + 1);
  await t.pay.tick();
  assert.equal(t.pay.billing.getInvoice(inv.id).status, 'paid');
});
