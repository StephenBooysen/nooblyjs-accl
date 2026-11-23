// The payments module (spec §2 payments/, §6 Collection): billing accounts, saved cards through the provider, collecting
// invoices off-session (with the 3-D Secure hand-off), dunning, refunds, provider webhooks and expiring-card notices.
// Every money movement is posted to the ledger; every write is audited.
import { conflict, forbidden, invalid, notFound, checker, ProviderError, PayError } from '../shared/errors.js';
import { newId, signToken, readToken } from '../shared/ids.js';
import { isCurrency, format, money } from '../shared/money.js';
import { assertCan, SYSTEM, hashOf } from '../shared/runtime.js';
import { createMutex } from '../shared/store.js';

const DAY = 24 * 3600 * 1000;
// A mailbox at a domain; a single-label domain (localhost, an intranet host) is allowed, as a start-up admin uses one.
const EMAIL = /^[^\s@]{1,64}@(?=[^\s@]{1,253}$)[^\s@.]+(\.[^\s@.]+)*$/;
const str = (v, maxLen) => typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;

/** A small queue for background work (webhook processing): run in order; idle() waits for the end. */
export function createWork(log) {
  let tail = Promise.resolve();
  return {
    run(fn) {
      tail = tail.then(fn).catch((err) => log?.error?.(`[accel-payments] background work failed: ${err.stack ?? err.message}`));
      return tail;
    },
    idle: () => tail,
  };
}

/**
 * @param {object} S   the shared state from index.js: repos, ledger, events, audit, clock, provider, notifier, options, work, log
 */
export function createPaymentsService(S) {
  const { repos, ledger, events, audit, clock, provider, notifier, options, work } = S;
  const now = () => clock.now();
  const iso = (ms = now()) => new Date(ms).toISOString();
  const invoiceLock = createMutex();
  const tokens = {
    action: (paymentId) => signToken(options.signingSecret, { k: 'a', p: paymentId, exp: now() + 14 * DAY }),
    invoice: (invoiceId) => signToken(options.signingSecret, { k: 'i', i: invoiceId }),
    read: (token, kind) => {
      const p = readToken(options.signingSecret, token, now());
      return p?.k === kind ? p : null;
    },
  };
  const publicUrl = (path) => `${options.publicUrl ?? ''}${options.basePath}/payments/p${path}`;
  const actionUrl = (paymentId) => publicUrl(`/actions/${tokens.action(paymentId)}`);
  const invoiceUrl = (invoiceId) => publicUrl(`/invoices/${tokens.invoice(invoiceId)}`);

  // ---- accounts -------------------------------------------------------------------------------------------------

  function checkAccount(input, { partial = false } = {}) {
    const c = checker();
    const has = (k) => input[k] !== undefined;
    if (!partial || has('name')) if (!str(input.name, 200)) c.fail('name', 'The name on invoices, up to 200 characters.');
    if (!partial || has('email')) if (typeof input.email !== 'string' || !EMAIL.test(input.email.trim())) c.fail('email', 'The billing email address.');
    if (has('externalRef') && input.externalRef !== null && !str(input.externalRef, 200)) c.fail('externalRef', 'Your id for this account, up to 200 characters.');
    if (has('currency') && !isCurrency(input.currency)) c.fail('currency', 'An ISO 4217 code such as USD.');
    if (has('country') && input.country !== null && !/^[A-Z]{2}$/.test(input.country ?? '')) c.fail('country', 'An ISO 3166 code such as ZA, or empty.');
    if (has('taxId') && input.taxId !== null && !str(input.taxId, 50)) c.fail('taxId', 'Up to 50 characters, or empty.');
    if (has('address') && input.address !== null) {
      if (typeof input.address !== 'object' || Array.isArray(input.address)) c.fail('address', 'An object with line1, line2, city, region, postalCode, country.');
      else for (const [k, v] of Object.entries(input.address)) {
        if (!['line1', 'line2', 'city', 'region', 'postalCode', 'country'].includes(k)) c.fail(`address.${k}`, 'Not an address field.');
        else if (v !== null && v !== '' && !str(v, 200)) c.fail(`address.${k}`, 'Up to 200 characters.');
      }
    }
    if (has('metadata') && (typeof input.metadata !== 'object' || Array.isArray(input.metadata) || Object.keys(input.metadata).length > 50 || Object.values(input.metadata).some((v) => typeof v !== 'string' || v.length > 500))) {
      c.fail('metadata', 'Up to 50 string values of up to 500 characters.');
    }
    c.throwIfAny();
  }

  const pick = (input, keys) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === 'string' ? input[k].trim() : input[k]]));
  const ACCOUNT_FIELDS = ['externalRef', 'customerId', 'name', 'email', 'currency', 'country', 'taxId', 'address', 'metadata', 'taxExempt'];

  async function providerCustomer(account) {
    if (account.providerCustomerRef) return account.providerCustomerRef;
    const { ref } = await provider.customers.create(account);
    const updated = await repos.accounts.update(account.id, (a) => (a.providerCustomerRef ? null : { ...a, providerCustomerRef: ref }));
    return updated.providerCustomerRef;
  }

  async function createAccount(input, ctx = SYSTEM) {
    assertCan(ctx, 'accounts.write');
    checkAccount(input);
    const account = await repos.accounts.insert({
      id: newId('acct'),
      externalRef: null, customerId: null, country: null, taxId: null, address: null, metadata: {}, taxExempt: false,
      ...pick(input, ACCOUNT_FIELDS),
      email: input.email.trim().toLowerCase(),
      currency: input.currency ?? options.currency,
      creditBalance: money(0, input.currency ?? options.currency),
      defaultMethodId: null, providerCustomerRef: null, status: 'active',
    });
    try {
      await providerCustomer(account);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      S.log?.warn?.(`[accel-payments] the provider did not create a customer for ${account.id} yet: ${err.message}`);
    }
    await audit.record({ ctx, action: 'account.created', ref: { type: 'account', id: account.id } });
    events.emit('pay.account.created', { accountId: account.id, externalRef: account.externalRef });
    return repos.accounts.get(account.id);
  }

  async function ensureAccount(input, ctx = SYSTEM) {
    if (!str(input?.externalRef, 200)) throw invalid('ensureAccount needs the externalRef (your id for the account).', [{ path: 'externalRef', message: 'Required.' }]);
    const existing = repos.accounts.by('externalRef', input.externalRef.trim());
    if (existing) return existing;
    try {
      return await createAccount(input, ctx);
    } catch (err) {
      const again = repos.accounts.by('externalRef', input.externalRef.trim());
      if (again) return again;
      throw err;
    }
  }

  async function updateAccount(id, patch, ctx = SYSTEM, { expectedVersion } = {}) {
    assertCan(ctx, 'accounts.write');
    checkAccount(patch, { partial: true });
    const current = repos.accounts.must(id, 'The account');
    if (patch.currency && patch.currency !== current.currency && repos.invoices.count((i) => i.accountId === id)) {
      throw conflict('The currency cannot change once an account has invoices.');
    }
    const fields = pick(patch, ACCOUNT_FIELDS.filter((k) => k !== 'externalRef'));
    if (fields.email) fields.email = fields.email.toLowerCase();
    const updated = await repos.accounts.update(id, (a) => ({ ...a, ...fields }), { expectedVersion, what: 'The account' });
    if (updated.providerCustomerRef && (fields.name || fields.email)) {
      await provider.customers.update(updated.providerCustomerRef, updated).catch((err) => S.log?.warn?.(`[accel-payments] provider customer update: ${err.message}`));
    }
    await audit.record({ ctx, action: 'account.updated', ref: { type: 'account', id }, details: { fields: Object.keys(fields) } });
    events.emit('pay.account.updated', { accountId: id, fields: Object.keys(fields) });
    return updated;
  }

  const getAccount = (id) => repos.accounts.must(id, 'The account');
  const lookup = (externalRef) => repos.accounts.by('externalRef', externalRef) ?? null;

  // ---- payment methods ------------------------------------------------------------------------------------------

  async function setupMethod(accountId, { returnUrl = null } = {}, ctx = SYSTEM) {
    assertCan(ctx, 'methods.write');
    const account = getAccount(accountId);
    if (account.status === 'closed') throw conflict('The account is closed.');
    const customerRef = await providerCustomer(account);
    const { ref, clientSecret, authorizationUrl } = await provider.methods.createSetup(customerRef, { returnUrl });
    const setup = await repos.setups.insert({ id: newId('seti'), accountId, providerRef: ref, status: 'pending', expiresAt: iso(now() + DAY) });
    await audit.record({ ctx, action: 'method.setup_started', ref: { type: 'account', id: accountId } });
    return {
      setupId: setup.id,
      ...provider.clientConfig(),
      clientSecret: clientSecret ?? null,
      authorizationUrl: authorizationUrl ?? null,
      ...(provider.name === 'mock' ? { fieldsUrl: publicUrl(`/mock/fields?secret=${encodeURIComponent(clientSecret)}`) } : {}),
    };
  }

  async function confirmMethod(accountId, setupId, { makeDefault = true } = {}, ctx = SYSTEM) {
    assertCan(ctx, 'methods.write');
    const account = getAccount(accountId);
    const setup = repos.setups.get(setupId);
    if (!setup || setup.accountId !== accountId) throw notFound('The card setup');
    if (setup.status === 'done') return repos.methods.get(setup.methodId);
    if (Date.parse(setup.expiresAt) < now()) throw conflict('This card form has expired. Open it again.');
    const { ref, display } = await provider.methods.confirmSetup(setup.providerRef);
    const existing = repos.methods.list((m) => m.accountId === accountId && m.providerRef === ref)[0];
    const method = existing ?? await repos.methods.insert({ id: newId('pm'), accountId, type: 'card', display, providerRef: ref, status: 'active', expiringNotified: null });
    await repos.setups.update(setupId, (s) => ({ ...s, status: 'done', methodId: method.id }));
    if (makeDefault || !account.defaultMethodId) await repos.accounts.update(accountId, (a) => ({ ...a, defaultMethodId: method.id }));
    await audit.record({ ctx, action: 'method.added', ref: { type: 'account', id: accountId }, details: { methodId: method.id, brand: display.brand, last4: display.last4 } });
    events.emit('pay.method.added', { accountId, methodId: method.id, brand: display.brand, last4: display.last4, isDefault: makeDefault || !account.defaultMethodId });
    // A new card pays what is overdue straight away.
    work.run(() => retryOverdue(accountId));
    return repos.methods.get(method.id);
  }

  function ownMethod(accountId, methodId) {
    const m = repos.methods.get(methodId);
    if (!m || m.accountId !== accountId || m.status !== 'active') throw notFound('The card');
    return m;
  }

  async function makeDefault(accountId, methodId, ctx = SYSTEM) {
    assertCan(ctx, 'methods.write');
    ownMethod(accountId, methodId);
    const updated = await repos.accounts.update(accountId, (a) => ({ ...a, defaultMethodId: methodId }), { what: 'The account' });
    await audit.record({ ctx, action: 'method.made_default', ref: { type: 'account', id: accountId }, details: { methodId } });
    return updated;
  }

  async function removeMethod(accountId, methodId, ctx = SYSTEM) {
    assertCan(ctx, 'methods.write');
    const m = ownMethod(accountId, methodId);
    await provider.methods.detach(m.providerRef).catch((err) => {
      if (!(err instanceof ProviderError)) throw err;
    });
    await repos.methods.update(methodId, (x) => ({ ...x, status: 'removed', removedAt: iso() }));
    const account = getAccount(accountId);
    if (account.defaultMethodId === methodId) {
      const next = repos.methods.list((x) => x.accountId === accountId && x.status === 'active').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      await repos.accounts.update(accountId, (a) => ({ ...a, defaultMethodId: next?.id ?? null }));
    }
    await audit.record({ ctx, action: 'method.removed', ref: { type: 'account', id: accountId }, details: { methodId } });
    events.emit('pay.method.removed', { accountId, methodId });
    return { removed: true };
  }

  const listMethods = (accountId) => repos.methods.list((m) => m.accountId === accountId && m.status === 'active')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  // ---- invoice states that move money ---------------------------------------------------------------------------

  async function setAccountStanding(accountId) {
    const account = getAccount(accountId);
    const troubled = repos.invoices.count((i) => i.accountId === accountId && (i.status === 'uncollectible' || (i.status === 'open' && i.final)));
    if (account.status === 'delinquent' && !troubled) {
      await repos.accounts.update(accountId, (a) => ({ ...a, status: 'active' }));
      events.emit('pay.account.reinstated', { accountId, externalRef: account.externalRef });
      await audit.record({ action: 'account.reinstated', ref: { type: 'account', id: accountId } });
    }
  }

  async function setSubscriptionStanding(invoice, status) {
    if (!invoice.subscriptionId) return;
    const sub = repos.subscriptions.get(invoice.subscriptionId);
    if (!sub) return;
    if (status === 'past_due' && sub.status === 'active') {
      await repos.subscriptions.update(sub.id, (s) => ({ ...s, status: 'past_due' }));
      events.emit('pay.subscription.past_due', { subscriptionId: sub.id, accountId: sub.accountId, invoiceId: invoice.id });
    } else if (status === 'active' && sub.status === 'past_due') {
      const others = repos.invoices.count((i) => i.subscriptionId === sub.id && i.id !== invoice.id && i.status === 'open' && (i.attempts ?? 0) > 0);
      if (!others) await repos.subscriptions.update(sub.id, (s) => ({ ...s, status: 'active' }));
    }
  }

  /** The invoice is paid: by a payment (ledger: cash/receivable), or with nothing left to pay. */
  async function markPaid(invoiceId, payment = null) {
    const inv = repos.invoices.must(invoiceId, 'The invoice');
    if (inv.status === 'paid') return inv;
    if (inv.status === 'uncollectible' && payment) {
      // Paid after all: take the bad debt back first.
      await ledger.post({ accountId: inv.accountId, currency: inv.currency, ref: { type: 'invoice', id: inv.id }, memo: `Invoice ${inv.number} collected after write-off`, lines: [['receivable', inv.amountRemaining.amount], ['bad_debt', -inv.amountRemaining.amount]] });
    }
    if (payment) {
      await ledger.post({ accountId: inv.accountId, currency: inv.currency, ref: { type: 'payment', id: payment.id }, memo: `Payment for invoice ${inv.number}`, lines: [['cash', payment.amount.amount], ['receivable', -payment.amount.amount]] });
    }
    const paid = await repos.invoices.update(invoiceId, (i) => ({
      ...i, status: 'paid', paidAt: iso(), nextAttemptAt: null, final: false,
      amountPaid: money(i.amountPaid.amount + (payment?.amount.amount ?? 0), i.currency),
      amountRemaining: money(0, i.currency),
      paymentId: payment?.id ?? i.paymentId ?? null,
    }));
    events.emit('pay.invoice.paid', { invoiceId, accountId: inv.accountId, number: inv.number, amountPaid: paid.amountPaid, paymentId: payment?.id ?? null });
    await setSubscriptionStanding(paid, 'active');
    await setAccountStanding(inv.accountId);
    return paid;
  }

  async function markUncollectible(invoiceId, ctx = SYSTEM, { reason = 'manual' } = {}) {
    assertCan(ctx, 'invoices.write');
    const inv = repos.invoices.must(invoiceId, 'The invoice');
    if (inv.status !== 'open') throw conflict(`Only an open invoice can be written off; ${inv.number ?? inv.id} is ${inv.status}.`);
    await ledger.post({ accountId: inv.accountId, currency: inv.currency, ref: { type: 'invoice', id: inv.id }, memo: `Invoice ${inv.number} written off`, lines: [['bad_debt', inv.amountRemaining.amount], ['receivable', -inv.amountRemaining.amount]] });
    const updated = await repos.invoices.update(invoiceId, (i) => ({ ...i, status: 'uncollectible', uncollectibleAt: iso(), nextAttemptAt: null }));
    await audit.record({ ctx, action: 'invoice.uncollectible', ref: { type: 'invoice', id: invoiceId }, details: { reason, amount: inv.amountRemaining } });
    events.emit('pay.invoice.uncollectible', { invoiceId, accountId: inv.accountId, number: inv.number, amount: inv.amountRemaining, reason });
    return updated;
  }

  // ---- collection and dunning -----------------------------------------------------------------------------------

  async function recordFailure(invoiceId, { failure, automatic, notice = true }) {
    const inv = repos.invoices.must(invoiceId);
    const account = getAccount(inv.accountId);
    const retryDays = options.dunning.retryDays;
    if (!automatic) {
      events.emit('pay.invoice.payment_failed', { invoiceId, accountId: inv.accountId, number: inv.number, attempt: inv.attempts ?? 0, reason: failure.code, nextAttemptAt: inv.nextAttemptAt, final: false, manual: true });
      return repos.invoices.get(invoiceId);
    }
    const attempts = (inv.attempts ?? 0) + 1;
    const firstFailedAt = inv.firstFailedAt ?? iso();
    const final = attempts > retryDays.length;
    const nextAttemptAt = final ? null : iso(Date.parse(firstFailedAt) + retryDays[attempts - 1] * DAY);
    await repos.invoices.update(invoiceId, (i) => ({ ...i, attempts, firstFailedAt, lastAttemptAt: iso(), nextAttemptAt, lastFailure: failure, final }));
    events.emit('pay.invoice.payment_failed', { invoiceId, accountId: inv.accountId, number: inv.number, attempt: attempts, reason: failure.code, nextAttemptAt, final });
    await setSubscriptionStanding(inv, 'past_due');
    if (notice || final) await notifier.send('payment.failed', { account, invoice: repos.invoices.get(invoiceId), failure, nextAttemptAt, final, url: invoiceUrl(invoiceId), idempotencyKey: `pay:failed:${invoiceId}:${attempts}` });
    if (final) {
      if (options.dunning.finalAction === 'cancel-subscription' && inv.subscriptionId) await S.billing?.cancelNow?.(inv.subscriptionId, { reason: 'unpaid' });
      await markUncollectible(invoiceId, SYSTEM, { reason: 'dunning' });
      await repos.invoices.update(invoiceId, (i) => ({ ...i, final: true }));
      if (account.status !== 'delinquent') {
        await repos.accounts.update(account.id, (a) => ({ ...a, status: 'delinquent', delinquentSince: iso() }));
        events.emit('pay.account.delinquent', { accountId: account.id, externalRef: account.externalRef, invoiceId, number: inv.number, amount: inv.amountRemaining });
        await audit.record({ action: 'account.delinquent', ref: { type: 'account', id: account.id }, details: { invoiceId } });
      }
      await notifier.send('account.delinquent', { account, invoice: inv, url: invoiceUrl(invoiceId), idempotencyKey: `pay:delinquent:${invoiceId}` });
    }
    return repos.invoices.get(invoiceId);
  }

  /** Applies what the provider said about a charge to our payment and its invoice. */
  async function applyCharge(paymentId, charge, { automatic }) {
    const payment = repos.payments.must(paymentId);
    if (['succeeded', 'failed'].includes(payment.status) && payment.providerRef === charge.ref) return payment;
    const status = charge.status;
    const updated = await repos.payments.update(paymentId, (p) => ({ ...p, providerRef: charge.ref, status, failure: charge.failure ?? null, settledAt: ['succeeded', 'failed'].includes(status) ? iso() : null }));
    const inv = payment.invoiceId ? repos.invoices.get(payment.invoiceId) : null;
    const account = getAccount(payment.accountId);
    const method = repos.methods.get(payment.methodId);
    if (status === 'succeeded') {
      events.emit('pay.payment.succeeded', { paymentId, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: payment.amount });
      if (inv) {
        await markPaid(inv.id, updated);
        await notifier.send('payment.succeeded', { account, invoice: repos.invoices.get(inv.id), method, url: invoiceUrl(inv.id), idempotencyKey: `pay:receipt:${paymentId}` });
      }
    } else if (status === 'failed') {
      events.emit('pay.payment.failed', { paymentId, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: payment.amount, reason: charge.failure?.code ?? 'card_declined' });
      if (inv) await recordFailure(inv.id, { failure: charge.failure ?? { code: 'card_declined', message: new ProviderError('card_declined').message }, automatic });
    } else if (status === 'requires_action') {
      const url = actionUrl(paymentId);
      events.emit('pay.payment.requires_action', { paymentId, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: payment.amount, actionUrl: url });
      if (inv) {
        await notifier.send('payment.action_required', { account, invoice: inv, url, idempotencyKey: `pay:action:${paymentId}` });
        // The schedule moves on (the cardholder may never confirm), but the email they get is the confirm one.
        if (automatic) await recordFailure(inv.id, { failure: { code: 'authentication_required', message: new ProviderError('authentication_required').message }, automatic: true, notice: false });
      }
    }
    return repos.payments.get(paymentId);
  }

  /**
   * Charges an open (or written-off) invoice's remaining amount to a card: the default one, or `methodId`.
   * Automatic attempts follow the dunning schedule; manual ones (Pay now, a new card) do not move it.
   */
  async function collect(invoiceId, { methodId = null, automatic = false, ctx = SYSTEM } = {}) {
    if (!automatic) assertCan(ctx, 'invoices.write');
    return invoiceLock(invoiceId, async () => {
      const inv = repos.invoices.must(invoiceId, 'The invoice');
      if (!['open', 'uncollectible'].includes(inv.status)) throw conflict(`Invoice ${inv.number ?? inv.id} is ${inv.status}.`);
      if (inv.paused) throw conflict('Collection is paused for this subscription.');
      if (inv.amountRemaining.amount <= 0) return { invoice: await markPaid(invoiceId), payment: null };
      const account = getAccount(inv.accountId);
      const method = methodId ? ownMethod(account.id, methodId) : (account.defaultMethodId ? repos.methods.get(account.defaultMethodId) : null);
      if (!method || method.status !== 'active') {
        const failure = { code: 'no_payment_method', message: new ProviderError('no_payment_method').message };
        events.emit('pay.payment.failed', { paymentId: null, accountId: account.id, invoiceId, amount: inv.amountRemaining, reason: failure.code });
        return { invoice: await recordFailure(invoiceId, { failure, automatic }), payment: null };
      }
      const n = repos.payments.count((p) => p.invoiceId === invoiceId) + 1;
      const payment = await repos.payments.insert({
        id: newId('py'), invoiceId, accountId: account.id, methodId: method.id, amount: inv.amountRemaining,
        status: 'processing', attempt: n, trigger: automatic ? 'automatic' : 'manual', providerRef: null, failure: null, refunded: money(0, inv.currency),
      });
      let charge;
      try {
        charge = await provider.charges.create({
          customerRef: await providerCustomer(account), methodRef: method.providerRef, amount: inv.amountRemaining,
          idempotencyKey: `${invoiceId}:${n}`, description: `Invoice ${inv.number}`, metadata: { invoiceId, accountId: account.id, paymentId: payment.id },
        });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        charge = { ref: null, status: 'failed', failure: { code: err.code, message: err.message } };
      }
      const after = await applyCharge(payment.id, charge, { automatic });
      return { invoice: repos.invoices.get(invoiceId), payment: after };
    });
  }

  /** Automatic retries that are due (spec §6 Collection). */
  async function runDunning() {
    const due = repos.invoices.list((i) => i.status === 'open' && !i.paused && i.nextAttemptAt && Date.parse(i.nextAttemptAt) <= now());
    for (const inv of due) await collect(inv.id, { automatic: true });
    return due.length;
  }

  /** After a new card: try what is overdue (open invoices that failed, and written-off ones). */
  async function retryOverdue(accountId) {
    const overdue = repos.invoices.list((i) => i.accountId === accountId && ((i.status === 'open' && (i.attempts ?? 0) > 0 && !i.paused) || i.status === 'uncollectible'));
    for (const inv of overdue) {
      try {
        await collect(inv.id, { automatic: false });
      } catch (err) {
        if (!(err instanceof PayError)) throw err;
      }
    }
  }

  // ---- 3-D Secure hand-off ----------------------------------------------------------------------------------------

  /** What the action page needs: the payment, its invoice, and for Stripe the PaymentIntent's client secret. */
  async function actionFor(token) {
    const p = tokens.read(token, 'a');
    const payment = p && repos.payments.get(p.p);
    if (!payment) throw notFound('This link');
    const invoice = payment.invoiceId ? repos.invoices.get(payment.invoiceId) : null;
    let clientSecret = null;
    if (payment.status === 'requires_action' && provider.name !== 'mock') {
      const charge = await provider.charges.get(payment.providerRef);
      clientSecret = charge.nextAction?.clientSecret ?? null;
    }
    return { payment, invoice, account: getAccount(payment.accountId), clientSecret, client: provider.clientConfig() };
  }

  /** After the cardholder's step: read the charge again (or, on the mock, complete it). */
  async function completeAction(token, { succeed = true } = {}) {
    const { payment } = await actionFor(token);
    if (payment.status !== 'requires_action') return payment;
    const charge = provider.name === 'mock' ? await provider.completeAction(payment.providerRef, { succeed }) : await provider.charges.get(payment.providerRef);
    await work.idle();
    return applyCharge(payment.id, charge, { automatic: false });
  }

  // ---- refunds --------------------------------------------------------------------------------------------------

  /** Refund reasons a provider knows (Stripe's); 'other' sends none. The text reason is always kept. */
  const REASON_CODES = ['requested_by_customer', 'duplicate', 'fraudulent', 'other'];

  async function refund({ paymentId, amount = null, reason = '', reasonCode = 'other', notifyCustomer = false, idempotencyKey = null, viaCredit = false }, ctx = SYSTEM) {
    assertCan(ctx, 'refunds.write');
    const payment = repos.payments.must(paymentId, 'The payment');
    if (payment.status !== 'succeeded') throw conflict('Only a successful payment can be refunded.');
    const left = payment.amount.amount - (payment.refunded?.amount ?? 0);
    const value = amount === null || amount === undefined ? left : amount;
    if (!Number.isSafeInteger(value) || value <= 0) throw invalid('The refund is a positive amount in minor units.', [{ path: 'amount', message: 'A positive integer.' }]);
    if (value > left) throw invalid(`At most ${format(money(left, payment.amount.currency))} is left to refund.`, [{ path: 'amount', message: 'More than what is left.' }]);
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) throw invalid('Say why, in 3 to 500 characters.', [{ path: 'reason', message: 'Required.' }]);
    if (!REASON_CODES.includes(reasonCode)) throw invalid('The reason is one of the provider\'s.', [{ path: 'reasonCode', message: REASON_CODES.join(', ') }]);
    const limit = options.support.refundLimit;
    if (!ctx.system && !ctx.roles?.some((r) => r === 'admin' || r === 'finance') && value > limit) {
      await audit.record({ ctx, action: 'refund.refused', ref: { type: 'payment', id: paymentId }, outcome: 'refused', details: { amount: value, limit } });
      throw forbidden(`Refunds above ${format(money(limit, payment.amount.currency))} need finance.`);
    }
    const n = repos.refunds.count((r) => r.paymentId === paymentId) + 1;
    const out = await provider.refunds.create({ chargeRef: payment.providerRef, amount: money(value, payment.amount.currency), idempotencyKey: idempotencyKey ? `refund:${hashOf(idempotencyKey).slice(0, 32)}` : `${paymentId}:refund:${n}`, reason, code: reasonCode === 'other' ? null : reasonCode });
    const existing = repos.refunds.list((r) => r.providerRef === out.ref)[0];
    if (existing) return existing;
    const record = await repos.refunds.insert({ id: newId('re'), paymentId, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: money(value, payment.amount.currency), status: out.status, reason: reason.trim(), reasonCode, providerRef: out.ref, by: ctx.actor ?? null, source: 'accelerator' });
    await bookRefund(record, payment, { viaCredit });
    await audit.record({ ctx, action: 'refund.created', ref: { type: 'payment', id: paymentId }, details: { refundId: record.id, amount: record.amount, reason: record.reason } });
    if (notifyCustomer === true) {
      await notifier.send('refund.succeeded', { account: getAccount(payment.accountId), invoice: payment.invoiceId ? repos.invoices.get(payment.invoiceId) : null, method: payment.methodId ? repos.methods.get(payment.methodId) : null, refund: record, url: payment.invoiceId ? invoiceUrl(payment.invoiceId) : undefined, idempotencyKey: `pay:refund:${record.id}` });
    }
    return repos.refunds.get(record.id);
  }

  async function bookRefund(record, payment, { viaCredit = false } = {}) {
    await repos.payments.update(payment.id, (p) => ({ ...p, refunded: money((p.refunded?.amount ?? 0) + record.amount.amount, p.amount.currency) }));
    await ledger.post({ accountId: payment.accountId, currency: record.amount.currency, ref: { type: 'refund', id: record.id }, memo: `Refund ${record.reason}`, lines: [[viaCredit ? 'customer_credit' : 'refunds', record.amount.amount], ['cash', -record.amount.amount]] });
    events.emit('pay.refund.succeeded', { refundId: record.id, paymentId: payment.id, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: record.amount });
  }

  // ---- webhooks -------------------------------------------------------------------------------------------------

  async function openIssue(kind, message, ref) {
    const issue = await repos.issues.insert({ id: newId('iss'), kind, message, ref, status: 'open', at: iso() });
    events.emit('pay.reconciliation.issue', { issueId: issue.id, kind, ref });
    return issue;
  }

  async function processEvent(e) {
    if (e.type === 'charge.succeeded' || e.type === 'charge.failed' || e.type === 'charge.requires_action') {
      const payment = repos.payments.list((p) => p.providerRef === e.data.chargeRef)[0];
      if (!payment) return 'unknown-charge';
      if (['succeeded', 'failed'].includes(payment.status)) return 'already-settled';
      const charge = await provider.charges.get(e.data.chargeRef);
      await applyCharge(payment.id, charge, { automatic: payment.trigger === 'automatic' });
      return `payment-${charge.status}`;
    }
    if (e.type === 'refund.succeeded') {
      if (repos.refunds.list((r) => r.providerRef === e.data.refundRef).length) return 'known-refund';
      const payment = repos.payments.list((p) => p.providerRef === e.data.chargeRef)[0];
      if (!payment) {
        await openIssue('refund_unknown_charge', `The provider refunded a charge this accelerator does not know (${e.data.chargeRef}).`, { type: 'charge', id: e.data.chargeRef });
        return 'unknown-charge';
      }
      const record = await repos.refunds.insert({ id: newId('re'), paymentId: payment.id, accountId: payment.accountId, invoiceId: payment.invoiceId, amount: e.data.amount, status: 'succeeded', reason: 'Refunded on the provider\'s dashboard', providerRef: e.data.refundRef, by: { type: 'provider', id: provider.name }, source: 'provider' });
      await bookRefund(record, payment);
      await openIssue('refund_outside', `${format(e.data.amount)} was refunded on the provider's dashboard, not here. It is recorded; check it was meant.`, { type: 'refund', id: record.id });
      return 'recorded-outside';
    }
    if (e.type === 'dispute.created') {
      const payment = repos.payments.list((p) => p.providerRef === e.data.chargeRef)[0];
      await openIssue('dispute', `The cardholder disputed ${e.data.amount ? format(e.data.amount) : 'a payment'} (${e.data.reason ?? 'no reason given'}).`, payment ? { type: 'payment', id: payment.id } : { type: 'charge', id: e.data.chargeRef });
      return 'issue-opened';
    }
    if (e.type === 'method.updated') {
      const m = repos.methods.list((x) => x.providerRef === e.data.methodRef)[0];
      if (!m || !e.data.display) return 'unknown-method';
      await repos.methods.update(m.id, (x) => ({ ...x, display: e.data.display, expiringNotified: null }));
      return 'method-updated';
    }
    return 'ignored';
  }

  /** A provider's webhook: signature checked on the raw body, de-duplicated by its event id, processed in order. */
  async function receiveWebhook(name, rawBody, headers) {
    if (name !== provider.name) throw notFound('That provider');
    try {
      provider.webhooks.verify(rawBody, headers);
    } catch (err) {
      await audit.record({ action: 'webhook.refused', outcome: 'refused', details: { provider: name, reason: err.message } });
      throw new PayError(400, 'invalid_signature', 'The webhook signature does not match.');
    }
    const e = provider.webhooks.parse(rawBody);
    const id = `wh_${hashOf(`${name}:${e.id}`).slice(0, 32)}`;
    if (repos.webhooks.get(id)) return { received: true, duplicate: true };
    try {
      await repos.webhooks.insert({ id, provider: name, eventId: e.id, type: e.type, receivedAt: iso(), processedAt: null, result: null });
    } catch (err) {
      if (err.status === 409) return { received: true, duplicate: true };
      throw err;
    }
    work.run(async () => {
      let result;
      try {
        result = await processEvent(e);
      } catch (err) {
        result = `failed: ${err.message}`;
        S.log?.error?.(`[accel-payments] webhook ${e.id} (${e.type}) failed: ${err.message}`);
      }
      await repos.webhooks.update(id, (w) => ({ ...w, processedAt: iso(), result }));
    });
    return { received: true, duplicate: false };
  }

  // ---- expiring cards -------------------------------------------------------------------------------------------

  /** Cards that expire at the end of this month or next: one notice per card per month. */
  async function checkExpiring() {
    const d = new Date(now());
    const ym = (y, m) => y * 12 + m;
    const current = ym(d.getUTCFullYear(), d.getUTCMonth() + 1);
    const tag = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let n = 0;
    for (const m of repos.methods.list((x) => x.status === 'active')) {
      const exp = ym(m.display.expYear, m.display.expMonth);
      if (exp < current || exp > current + 1 || m.expiringNotified === tag) continue;
      const account = repos.accounts.get(m.accountId);
      if (!account || account.defaultMethodId !== m.id) continue;
      await repos.methods.update(m.id, (x) => ({ ...x, expiringNotified: tag }));
      events.emit('pay.method.expiring', { accountId: m.accountId, methodId: m.id, expMonth: m.display.expMonth, expYear: m.display.expYear });
      await notifier.send('card.expiring', { account, method: m, idempotencyKey: `pay:expiring:${m.id}:${tag}` });
      n += 1;
    }
    return n;
  }

  return {
    createAccount, ensureAccount, updateAccount, getAccount, lookup,
    listAccounts: (test) => repos.accounts.list(test),
    setupMethod, confirmMethod, makeDefault, removeMethod, listMethods,
    collect, runDunning, retryOverdue, markPaid, markUncollectible,
    actionFor, completeAction, refund, receiveWebhook, checkExpiring, openIssue,
    invoiceUrl, actionUrl, tokens,
    listPayments: (test) => repos.payments.list(test),
    listRefunds: (test) => repos.refunds.list(test),
    listIssues: (test) => repos.issues.list(test),
    resolveIssue: async (id, ctx = SYSTEM) => {
      assertCan(ctx, 'invoices.write');
      const issue = await repos.issues.update(id, (i) => ({ ...i, status: 'resolved', resolvedAt: iso(), resolvedBy: ctx.actor }), { what: 'The issue' });
      await audit.record({ ctx, action: 'issue.resolved', ref: { type: 'issue', id } });
      return issue;
    },
    bookRefund,
  };
}
