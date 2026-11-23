// The Stripe adapter (spec §5; roadmap 3.5) over fetch against Stripe's REST API, no SDK. Cards are captured by Stripe's
// Payment Element on a SetupIntent (the browser talks to Stripe; we see the PaymentMethod's id and display data);
// renewals are off-session PaymentIntents; webhooks are checked with Stripe-Signature (HMAC-SHA256, 5 minute tolerance).
// The secret key comes from the options (or the environment); it is never stored, logged or returned.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../shared/errors.js';

const API = 'https://api.stripe.com';

/** application/x-www-form-urlencoded with Stripe's bracket nesting. */
export function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? parts.push(formEncode(item, `${key}[${i}]`)) : parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

const display = (pm) => (pm?.card ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : null);

function mapError(status, body) {
  const e = body?.error ?? {};
  if (status >= 500 || status === 429) return new ProviderError('unavailable');
  if (status === 401 || status === 403) return Object.assign(new Error('Stripe refused the secret key (check STRIPE_SECRET_KEY).'), { status: 500 });
  const code = e.decline_code === 'insufficient_funds' ? 'insufficient_funds' : e.code;
  if (['card_declined', 'expired_card', 'insufficient_funds', 'authentication_required'].includes(code)) return new ProviderError(code, undefined, { providerCode: e.decline_code ?? e.code });
  return new ProviderError('invalid', undefined, { providerCode: e.code ?? null });
}

/**
 * @param {{ secretKey: string, webhookSecret: string, publishableKey?: string, apiBase?: string, fetch?: typeof fetch, clock?: { now(): number } }} o
 */
export function createStripeProvider({ secretKey, webhookSecret, publishableKey = null, apiBase = API, fetch: doFetch = globalThis.fetch, clock = { now: () => Date.now() } }) {
  if (!secretKey || !webhookSecret) throw new Error('The Stripe provider needs secretKey and webhookSecret.');

  async function call(method, path, params = null, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${secretKey}`, 'stripe-version': '2024-06-20' };
    let url = `${apiBase}${path}`;
    let body;
    if (method === 'GET' && params) url += `?${formEncode(params)}`;
    else if (params) {
      body = formEncode(params);
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res;
    try {
      res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ProviderError('unavailable');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = mapError(res.status, json);
      err.stripe = json?.error ?? null;
      throw err;
    }
    return json;
  }

  const chargeOf = (pi, fallbackStatus) => {
    const status = pi.status === 'succeeded' ? 'succeeded'
      : pi.status === 'processing' ? 'processing'
        : pi.status === 'requires_action' || pi.status === 'requires_confirmation' ? 'requires_action'
          : fallbackStatus ?? 'failed';
    const failure = pi.last_payment_error ? { code: pi.last_payment_error.decline_code === 'insufficient_funds' ? 'insufficient_funds' : (pi.last_payment_error.code ?? 'card_declined'), message: new ProviderError(pi.last_payment_error.code === 'expired_card' ? 'expired_card' : 'card_declined').message } : null;
    return {
      ref: pi.id,
      status,
      amount: { amount: pi.amount, currency: String(pi.currency).toUpperCase() },
      ...(status === 'requires_action' ? { nextAction: { type: 'authenticate', clientSecret: pi.client_secret } } : {}),
      ...(status === 'failed' && failure ? { failure } : {}),
    };
  };

  let account = null;
  return {
    name: 'stripe',
    clientConfig: () => ({ provider: 'stripe', publishableKey }),
    /** The connection as the Setup screen shows it: test or live (from the key), and the Stripe account id. */
    async describe() {
      if (!account) {
        try {
          const a = await call('GET', '/v1/account');
          account = { id: a.id, name: a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? null };
        } catch {
          account = { id: null, name: null };
        }
      }
      return { name: 'stripe', label: 'Stripe', mode: secretKey.startsWith('sk_live_') ? 'live' : 'test', account: account.id, accountName: account.name, publishableKey: Boolean(publishableKey), webhookSecret: Boolean(webhookSecret), webhookEvents: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.requires_action', 'refund.created', 'charge.dispute.created', 'payment_method.updated', 'payment_method.automatically_updated'], dashboard: secretKey.startsWith('sk_live_') ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test' };
    },

    customers: {
      async create(account) {
        const c = await call('POST', '/v1/customers', { name: account.name, email: account.email, metadata: { accountId: account.id, externalRef: account.externalRef ?? '' } }, { idempotencyKey: `customer:${account.id}` });
        return { ref: c.id };
      },
      async update(ref, account) {
        await call('POST', `/v1/customers/${encodeURIComponent(ref)}`, { name: account.name, email: account.email });
        return { ref };
      },
    },

    methods: {
      async createSetup(customerRef) {
        const s = await call('POST', '/v1/setup_intents', { customer: customerRef, usage: 'off_session', payment_method_types: ['card'] });
        return { ref: s.id, clientSecret: s.client_secret };
      },
      async confirmSetup(setupRef) {
        const s = await call('GET', `/v1/setup_intents/${encodeURIComponent(setupRef)}`, { expand: ['payment_method'] });
        if (s.status !== 'succeeded' || !s.payment_method) throw new ProviderError('invalid', 'The card details were not completed.');
        const pm = typeof s.payment_method === 'string' ? await call('GET', `/v1/payment_methods/${encodeURIComponent(s.payment_method)}`) : s.payment_method;
        return { ref: pm.id, display: display(pm) };
      },
      async detach(ref) {
        await call('POST', `/v1/payment_methods/${encodeURIComponent(ref)}/detach`);
        return { ref };
      },
    },

    charges: {
      async create({ customerRef, methodRef, amount, idempotencyKey, description, metadata = {} }) {
        try {
          const pi = await call('POST', '/v1/payment_intents', {
            amount: amount.amount, currency: amount.currency.toLowerCase(), customer: customerRef, payment_method: methodRef,
            off_session: true, confirm: true, description, metadata,
          }, { idempotencyKey });
          return chargeOf(pi);
        } catch (err) {
          // Off-session: a card that needs 3-D Secure fails with authentication_required; the PaymentIntent is handed
          // to the cardholder (the hosted action page confirms it on-session).
          const pi = err.stripe?.payment_intent;
          if (pi && err.code === 'authentication_required') return { ...chargeOf(pi, 'requires_action'), status: 'requires_action', nextAction: { type: 'authenticate', clientSecret: pi.client_secret } };
          if (pi && err instanceof ProviderError) return { ...chargeOf(pi, 'failed'), status: 'failed', failure: { code: err.code, message: err.message } };
          throw err;
        }
      },
      async get(ref) {
        return chargeOf(await call('GET', `/v1/payment_intents/${encodeURIComponent(ref)}`), 'failed');
      },
    },

    refunds: {
      async create({ chargeRef, amount, idempotencyKey, reason = '', code = null }) {
        const r = await call('POST', '/v1/refunds', { payment_intent: chargeRef, amount: amount.amount, ...(code ? { reason: code } : {}), metadata: { reason: reason.slice(0, 450) } }, { idempotencyKey });
        return { ref: r.id, chargeRef, amount: { amount: r.amount, currency: String(r.currency).toUpperCase() }, status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending' };
      },
      async get(ref) {
        const r = await call('GET', `/v1/refunds/${encodeURIComponent(ref)}`);
        return { ref: r.id, chargeRef: r.payment_intent, amount: { amount: r.amount, currency: String(r.currency).toUpperCase() }, status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending' };
      },
    },

    webhooks: {
      verify(rawBody, headers) {
        const header = headers['stripe-signature'] ?? '';
        const t = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);
        const signatures = [...header.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map((m) => m[1]);
        const expected = Buffer.from(createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`).digest('hex'));
        const ok = signatures.some((s) => {
          const b = Buffer.from(s);
          return b.length === expected.length && timingSafeEqual(b, expected);
        });
        if (!t || !ok) throw new ProviderError('invalid', 'The webhook signature does not match.');
        if (Math.abs(clock.now() / 1000 - t) > 300) throw new ProviderError('invalid', 'The webhook is too old.');
      },
      parse(rawBody) {
        const e = JSON.parse(String(rawBody));
        const o = e.data?.object ?? {};
        const map = {
          'payment_intent.succeeded': () => ({ type: 'charge.succeeded', data: { chargeRef: o.id } }),
          'payment_intent.payment_failed': () => ({ type: 'charge.failed', data: { chargeRef: o.id, failure: o.last_payment_error ? { code: o.last_payment_error.code ?? 'card_declined', message: new ProviderError('card_declined').message } : null } }),
          'payment_intent.requires_action': () => ({ type: 'charge.requires_action', data: { chargeRef: o.id } }),
          'refund.created': () => ({ type: 'refund.succeeded', data: { refundRef: o.id, chargeRef: o.payment_intent, amount: { amount: o.amount, currency: String(o.currency).toUpperCase() } } }),
          'charge.dispute.created': () => ({ type: 'dispute.created', data: { chargeRef: o.payment_intent, amount: { amount: o.amount, currency: String(o.currency).toUpperCase() }, reason: o.reason } }),
          'payment_method.updated': () => ({ type: 'method.updated', data: { methodRef: o.id, display: display(o) } }),
          'payment_method.automatically_updated': () => ({ type: 'method.updated', data: { methodRef: o.id, display: display(o) } }),
        };
        const mapped = map[e.type]?.() ?? { type: 'other', data: { providerType: e.type } };
        return { id: e.id, created: e.created, ...mapped };
      },
    },

    balance: {
      async transactions({ from, to, cursor } = {}) {
        const created = {};
        if (from) created.gte = Math.floor(Date.parse(from) / 1000);
        if (to) created.lt = Math.floor(Date.parse(to) / 1000);
        const page = await call('GET', '/v1/balance_transactions', { limit: 100, ...(Object.keys(created).length ? { created } : {}), ...(cursor ? { starting_after: cursor } : {}) });
        return page.data.map((t) => ({ ref: t.id, type: t.type, source: t.source, amount: t.amount, currency: String(t.currency).toUpperCase(), created: new Date(t.created * 1000).toISOString() }));
      },
    },
  };
}
