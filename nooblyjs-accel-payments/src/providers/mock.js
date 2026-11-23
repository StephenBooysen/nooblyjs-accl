// The mock provider (spec §5, steering §3.6): in memory, deterministic test cards, failure injection, out-of-band
// events (a refund or a dispute made on the "provider's dashboard"), and webhooks signed like Stripe's. Its hosted
// fields stand-in (`hostedFields.attach`) is the only place a card number arrives, and it keeps only the brand, the
// last 4 digits, the expiry and how the test card behaves.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../shared/errors.js';
import { randomToken } from '../shared/ids.js';

/** Test cards: what each does at setup and when charged (mirrors Stripe's test numbers). */
export const TEST_CARDS = {
  '4242424242424242': { brand: 'visa', setup: 'ok', charge: 'succeeded' },
  '5555555555554444': { brand: 'mastercard', setup: 'ok', charge: 'succeeded' },
  '378282246310005': { brand: 'amex', setup: 'ok', charge: 'succeeded' },
  '4000000000000002': { brand: 'visa', setup: 'card_declined', charge: 'card_declined' },
  '4000000000000341': { brand: 'visa', setup: 'ok', charge: 'card_declined' },
  '4000000000009995': { brand: 'visa', setup: 'ok', charge: 'insufficient_funds' },
  '4000002760003184': { brand: 'visa', setup: 'ok', charge: 'authentication_required' },
};

export const luhn = (digits) => {
  let total = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    total += d;
  }
  return total % 10 === 0;
};

const brandOf = (n) => (/^4/.test(n) ? 'visa' : /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n) ? 'mastercard' : /^3[47]/.test(n) ? 'amex' : 'card');

/**
 * @param {{ clock?: { now(): number }, webhookSecret?: string }} [o]
 */
export function createMockProvider({ clock = { now: () => Date.now() }, webhookSecret = 'whsec_mock' } = {}) {
  const customers = new Map();
  const setups = new Map();
  const methods = new Map();
  const charges = new Map();
  const refunds = new Map();
  const byKey = new Map();
  const balance = [];
  const injected = [];
  const listeners = new Set();
  let seq = 0;
  const id = (prefix) => `${prefix}_mock_${randomToken(12)}`;
  const iso = () => new Date(clock.now()).toISOString();

  function injectedFailure(op) {
    const i = injected.findIndex((f) => f.op === op);
    if (i === -1) return null;
    const f = injected[i];
    if (f.once !== false) injected.splice(i, 1);
    return f.reason;
  }

  function sign(body, at = clock.now()) {
    const t = Math.floor(at / 1000);
    const v1 = createHmac('sha256', webhookSecret).update(`${t}.${body}`).digest('hex');
    return { 'mock-signature': `t=${t},v1=${v1}` };
  }

  /** Queues a provider event and delivers it to the subscribers (as the real provider's webhook would). */
  async function send(type, data) {
    seq += 1;
    const body = JSON.stringify({ id: `evt_mock_${seq}_${randomToken(6)}`, type, created: Math.floor(clock.now() / 1000), data });
    const headers = sign(body);
    for (const fn of listeners) await fn(body, headers);
    return { body, headers };
  }

  function chargeOutcome(method) {
    const forced = injectedFailure('charge');
    if (forced) return forced;
    if (!method || method.detached) return 'invalid';
    const [m, y] = [method.display.expMonth, method.display.expYear];
    const now = new Date(clock.now());
    if (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1)) return 'expired_card';
    return method.behaviour;
  }

  return {
    name: 'mock',
    /** What the card form needs to load the hosted fields (the host serves the stand-in page, see routes/public.js). */
    clientConfig: () => ({ provider: 'mock' }),
    /** The connection as the Setup screen shows it. */
    describe: async () => ({ name: 'mock', label: 'Mock provider', mode: 'test', account: 'acct_mock', accountName: 'Test cards only', publishableKey: false, webhookSecret: true, webhookEvents: ['charge.succeeded', 'charge.failed', 'charge.requires_action', 'refund.succeeded', 'dispute.created', 'method.updated'], dashboard: null }),

    customers: {
      async create(account) {
        if (injectedFailure('customer')) throw new ProviderError('unavailable');
        const ref = id('cus');
        customers.set(ref, { ref, name: account.name, email: account.email });
        return { ref };
      },
      async update(ref, account) {
        const c = customers.get(ref);
        if (c) Object.assign(c, { name: account.name, email: account.email });
        return { ref };
      },
    },

    methods: {
      async createSetup(customerRef) {
        if (!customers.has(customerRef)) throw new ProviderError('invalid', 'The provider does not know this customer.');
        const ref = id('seti');
        const clientSecret = `${ref}_secret_${randomToken(16)}`;
        setups.set(ref, { ref, clientSecret, customerRef, status: 'requires_payment_method', card: null });
        return { ref, clientSecret };
      },
      async confirmSetup(setupRef) {
        const s = setups.get(setupRef);
        if (!s) throw new ProviderError('invalid', 'The card setup was not found.');
        if (s.status !== 'succeeded' || !s.card) throw new ProviderError('invalid', 'The card details were not completed.');
        if (s.methodRef) return { ref: s.methodRef, display: methods.get(s.methodRef).display };
        const ref = id('pm');
        methods.set(ref, { ref, customerRef: s.customerRef, display: s.card.display, behaviour: s.card.behaviour, detached: false });
        s.methodRef = ref;
        return { ref, display: s.card.display };
      },
      async detach(ref) {
        const m = methods.get(ref);
        if (m) m.detached = true;
        return { ref };
      },
    },

    charges: {
      async create({ customerRef, methodRef, amount, idempotencyKey, description = '', metadata = {} }) {
        if (idempotencyKey && byKey.has(`charge:${idempotencyKey}`)) return { ...charges.get(byKey.get(`charge:${idempotencyKey}`)) };
        if (!Number.isSafeInteger(amount.amount) || amount.amount <= 0) throw new ProviderError('invalid', 'A charge is a positive amount.');
        const method = methods.get(methodRef);
        if (method && method.customerRef !== customerRef) throw new ProviderError('invalid', 'The card belongs to another customer.');
        const outcome = chargeOutcome(method);
        const ref = id('ch');
        const charge = { ref, amount, description, metadata, created: iso(), methodRef, customerRef, refunded: 0 };
        if (outcome === 'succeeded') {
          charge.status = 'succeeded';
          balance.push({ ref: `txn_${ref}`, type: 'charge', source: ref, amount: amount.amount, currency: amount.currency, created: iso() });
        } else if (outcome === 'authentication_required') {
          charge.status = 'requires_action';
          charge.nextAction = { type: 'authenticate', clientSecret: `${ref}_secret_${randomToken(12)}` };
        } else if (outcome === 'unavailable') {
          throw new ProviderError('unavailable');
        } else {
          charge.status = 'failed';
          charge.failure = { code: outcome, message: new ProviderError(outcome).message };
        }
        charges.set(ref, charge);
        if (idempotencyKey) byKey.set(`charge:${idempotencyKey}`, ref);
        return { ...charge };
      },
      async get(ref) {
        const c = charges.get(ref);
        if (!c) throw new ProviderError('invalid', 'The charge was not found.');
        return { ...c };
      },
    },

    refunds: {
      async create({ chargeRef, amount, idempotencyKey, reason = '' }) {
        if (idempotencyKey && byKey.has(`refund:${idempotencyKey}`)) return { ...refunds.get(byKey.get(`refund:${idempotencyKey}`)) };
        if (injectedFailure('refund')) throw new ProviderError('unavailable');
        const c = charges.get(chargeRef);
        if (!c || c.status !== 'succeeded') throw new ProviderError('invalid', 'Only a successful charge can be refunded.');
        if (amount.amount <= 0 || amount.amount > c.amount.amount - c.refunded) throw new ProviderError('invalid', 'The refund is more than what is left of the charge.');
        c.refunded += amount.amount;
        const ref = id('re');
        const refund = { ref, chargeRef, amount, reason, status: 'succeeded', created: iso() };
        refunds.set(ref, refund);
        if (idempotencyKey) byKey.set(`refund:${idempotencyKey}`, ref);
        balance.push({ ref: `txn_${ref}`, type: 'refund', source: ref, amount: -amount.amount, currency: amount.currency, created: iso() });
        return { ...refund };
      },
      async get(ref) {
        const r = refunds.get(ref);
        if (!r) throw new ProviderError('invalid', 'The refund was not found.');
        return { ...r };
      },
    },

    webhooks: {
      /** Throws unless the signature matches (and is no older than 5 minutes). */
      verify(rawBody, headers) {
        const header = headers['mock-signature'] ?? '';
        const t = Number(/t=(\d+)/.exec(header)?.[1]);
        const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1] ?? '';
        const expected = createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest('hex');
        const a = Buffer.from(v1);
        const b = Buffer.from(expected);
        if (!t || a.length !== b.length || !timingSafeEqual(a, b)) throw new ProviderError('invalid', 'The webhook signature does not match.');
        if (Math.abs(clock.now() / 1000 - t) > 300) throw new ProviderError('invalid', 'The webhook is too old.');
      },
      parse(rawBody) {
        const e = JSON.parse(String(rawBody));
        return { id: e.id, type: e.type, data: e.data ?? {}, created: e.created };
      },
    },

    balance: {
      async transactions({ from, to } = {}) {
        return balance.filter((t) => (!from || t.created >= from) && (!to || t.created < to)).map((t) => ({ ...t }));
      },
    },

    // ---- the mock's own controls --------------------------------------------------------------------------------
    /** The hosted fields stand-in: the card number stops here. Returns the display data only. */
    hostedFields: {
      attach(clientSecret, { number, expMonth, expYear, cvc }) {
        const s = [...setups.values()].find((x) => x.clientSecret === clientSecret);
        if (!s) throw new ProviderError('invalid', 'This card form has expired. Open it again.');
        const digits = String(number ?? '').replace(/[\s-]/g, '');
        if (!/^\d{13,19}$/.test(digits) || !luhn(digits)) throw new ProviderError('invalid', 'The card number is not valid.');
        const m = Number(expMonth);
        let y = Number(expYear);
        if (y < 100) y += 2000;
        if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) throw new ProviderError('invalid', 'The expiry date is not valid.');
        if (!/^\d{3,4}$/.test(String(cvc ?? ''))) throw new ProviderError('invalid', 'The security code is 3 or 4 digits.');
        const now = new Date(clock.now());
        if (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1)) throw new ProviderError('expired_card');
        const test = TEST_CARDS[digits] ?? { brand: brandOf(digits), setup: 'ok', charge: 'succeeded' };
        if (test.setup !== 'ok') throw new ProviderError(test.setup);
        s.card = { display: { brand: test.brand, last4: digits.slice(-4), expMonth: m, expYear: y }, behaviour: test.charge };
        s.status = 'succeeded';
        return { ...s.card.display };
      },
    },
    /** Completes (or fails) a charge's 3-D Secure step, as the bank's page would. */
    async completeAction(chargeRef, { succeed = true } = {}) {
      const c = charges.get(chargeRef);
      if (!c || c.status !== 'requires_action') throw new ProviderError('invalid', 'Nothing is waiting for this payment.');
      if (succeed) {
        c.status = 'succeeded';
        balance.push({ ref: `txn_${c.ref}`, type: 'charge', source: c.ref, amount: c.amount.amount, currency: c.amount.currency, created: iso() });
      } else {
        c.status = 'failed';
        c.failure = { code: 'authentication_required', message: 'The cardholder did not confirm the payment.' };
      }
      delete c.nextAction;
      await send(succeed ? 'charge.succeeded' : 'charge.failed', { chargeRef: c.ref, failure: c.failure ?? null });
      return { ...c };
    },
    /** Makes the next call of `op` ('charge', 'refund', 'customer') fail with `reason` (once, unless once: false). */
    inject(op, reason, { once = true } = {}) {
      injected.push({ op, reason, once });
    },
    clearInjected() { injected.length = 0; },
    /** A refund made on the provider's dashboard, outside this accelerator. */
    async refundOutOfBand(chargeRef, amount) {
      const c = charges.get(chargeRef);
      if (!c) throw new ProviderError('invalid', 'The charge was not found.');
      c.refunded += amount;
      const ref = id('re');
      refunds.set(ref, { ref, chargeRef, amount: { amount, currency: c.amount.currency }, reason: 'dashboard', status: 'succeeded', created: iso() });
      balance.push({ ref: `txn_${ref}`, type: 'refund', source: ref, amount: -amount, currency: c.amount.currency, created: iso() });
      return send('refund.succeeded', { refundRef: ref, chargeRef, amount: { amount, currency: c.amount.currency } });
    },
    async dispute(chargeRef, reason = 'fraudulent') {
      const c = charges.get(chargeRef);
      return send('dispute.created', { chargeRef, amount: c?.amount ?? null, reason });
    },
    /** Delivers this provider's events (the accelerator subscribes its webhook handler). */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sign,
    /** For tests: what the provider holds (never a card number). */
    state: { customers, setups, methods, charges, refunds, balance },
  };
}
