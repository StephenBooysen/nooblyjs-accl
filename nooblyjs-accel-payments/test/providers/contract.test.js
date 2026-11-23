// The provider contract (spec §5, §11): run against the mock always; against a Stripe sandbox when RUN_STRIPE_TESTS=1
// and STRIPE_SECRET_KEY is set. The Stripe adapter's own logic (form encoding, webhook signatures, error mapping) is
// checked offline against a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMockProvider, createStripeProvider, missingFunctions } from '../../index.js';
import { formEncode } from '../../src/providers/stripe.js';

async function contract(provider, { saveCard }) {
  assert.deepEqual(missingFunctions(provider), []);
  const { ref: customerRef } = await provider.customers.create({ id: 'acct_test', name: 'Contract Co', email: 'contract@example.com' });
  assert.ok(customerRef);
  const setup = await provider.methods.createSetup(customerRef, {});
  assert.ok(setup.ref);
  await saveCard(setup);
  const method = await provider.methods.confirmSetup(setup.ref);
  assert.match(method.display.last4, /^\d{4}$/);
  const charge = await provider.charges.create({ customerRef, methodRef: method.ref, amount: { amount: 1234, currency: 'USD' }, idempotencyKey: `contract-${Date.now()}`, description: 'Contract test' });
  assert.equal(charge.status, 'succeeded');
  assert.equal((await provider.charges.get(charge.ref)).status, 'succeeded');
  const refund = await provider.refunds.create({ chargeRef: charge.ref, amount: { amount: 234, currency: 'USD' }, idempotencyKey: `contract-refund-${Date.now()}`, reason: 'Contract test' });
  assert.ok(['succeeded', 'pending'].includes(refund.status));
  assert.ok(Array.isArray(await provider.balance.transactions({})));
  await provider.methods.detach(method.ref);
}

test('the mock provider keeps the contract', async () => {
  const p = createMockProvider();
  await contract(p, { saveCard: async (setup) => p.hostedFields.attach(setup.clientSecret, { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, cvc: '123' }) });
  // Idempotent charges, and webhooks signed like Stripe's.
  const body = '{"id":"evt_1","type":"other","data":{}}';
  p.webhooks.verify(body, p.sign(body));
  assert.throws(() => p.webhooks.verify(body.replace('1', '2'), p.sign(body)), /signature/);
});

test('the Stripe adapter: form encoding, signatures with tolerance, errors mapped to plain reasons', async () => {
  assert.equal(formEncode({ a: 1, metadata: { x: 'y z' }, list: ['card'], skip: null }), 'a=1&metadata%5Bx%5D=y%20z&list%5B%5D=card');
  const calls = [];
  const replies = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = replies.shift();
    return { ok: status < 400, status, json: async () => body };
  };
  const now = Date.parse('2026-06-01T00:00:00Z');
  const s = createStripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', publishableKey: 'pk_test_x', fetch: fakeFetch, clock: { now: () => now } });
  assert.deepEqual(missingFunctions(s), []);
  replies.push([200, { id: 'pi_1', status: 'succeeded', amount: 500, currency: 'usd' }]);
  const ok = await s.charges.create({ customerRef: 'cus_1', methodRef: 'pm_1', amount: { amount: 500, currency: 'USD' }, idempotencyKey: 'in_1:1', description: 'Invoice' });
  assert.deepEqual([ok.ref, ok.status, ok.amount.currency], ['pi_1', 'succeeded', 'USD']);
  assert.equal(calls[0].init.headers['idempotency-key'], 'in_1:1');
  assert.match(calls[0].init.body, /off_session=true/);
  assert.ok(!JSON.stringify(calls).includes('sk_test_x') || calls[0].init.headers.authorization === 'Bearer sk_test_x');
  replies.push([402, { error: { code: 'authentication_required', payment_intent: { id: 'pi_2', status: 'requires_payment_method', client_secret: 'pi_2_secret', amount: 500, currency: 'usd' } } }]);
  const sca = await s.charges.create({ customerRef: 'cus_1', methodRef: 'pm_1', amount: { amount: 500, currency: 'USD' }, idempotencyKey: 'in_1:2' });
  assert.deepEqual([sca.status, sca.nextAction.clientSecret], ['requires_action', 'pi_2_secret']);
  replies.push([402, { error: { code: 'card_declined', decline_code: 'insufficient_funds', payment_intent: { id: 'pi_3', status: 'requires_payment_method', amount: 500, currency: 'usd' } } }]);
  const declined = await s.charges.create({ customerRef: 'cus_1', methodRef: 'pm_1', amount: { amount: 500, currency: 'USD' }, idempotencyKey: 'in_1:3' });
  assert.deepEqual([declined.status, declined.failure.code], ['failed', 'insufficient_funds']);
  replies.push([503, {}]);
  await assert.rejects(s.customers.create({ id: 'a', name: 'n', email: 'e@x.test' }), (e) => e.code === 'unavailable');
  const body = JSON.stringify({ id: 'evt_s', type: 'refund.created', data: { object: { id: 're_1', payment_intent: 'pi_1', amount: 100, currency: 'usd' } } });
  const t = Math.floor(now / 1000);
  const sig = createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex');
  s.webhooks.verify(body, { 'stripe-signature': `t=${t},v1=${sig}` });
  assert.throws(() => s.webhooks.verify(body, { 'stripe-signature': `t=${t - 600},v1=${createHmac('sha256', 'whsec_x').update(`${t - 600}.${body}`).digest('hex')}` }), /too old/);
  assert.throws(() => s.webhooks.verify(body, { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` }), /signature/);
  assert.deepEqual(s.webhooks.parse(body), { id: 'evt_s', created: undefined, type: 'refund.succeeded', data: { refundRef: 're_1', chargeRef: 'pi_1', amount: { amount: 100, currency: 'USD' } } });
  assert.deepEqual(s.clientConfig(), { provider: 'stripe', publishableKey: 'pk_test_x' });
});

test('the Stripe sandbox keeps the contract', { skip: process.env.RUN_STRIPE_TESTS !== '1' || !process.env.STRIPE_SECRET_KEY ? 'set RUN_STRIPE_TESTS=1 and STRIPE_SECRET_KEY' : false }, async () => {
  const s = createStripeProvider({ secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_unused' });
  // A test PaymentMethod (pm_card_visa) attached through the SetupIntent, as the Payment Element would.
  await contract(s, {
    saveCard: async (setup) => {
      const res = await fetch(`https://api.stripe.com/v1/setup_intents/${setup.ref}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'payment_method=pm_card_visa' });
      assert.equal(res.status, 200);
    },
  });
});
