// Emails to the account's billing address (spec §8): invoice ready, receipt, payment failed (each attempt), action
// required (3-D Secure), card expiring, account delinquent. Through the customers accelerator's transactional send when
// the host passes it (its consent and suppression pipeline, templates operators may edit), or the host's own
// `notify(kind, data)`. A failed email is logged and audited, never thrown: it must not undo a payment.
import { format } from '../shared/money.js';

const wrap = (body) => `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#241C1A;padding:24px">${body}<p style="color:#7A6A63;font-size:13px">{{brand}} billing</p></body></html>`;

export const PAY_TEMPLATES = [
  {
    key: 'pay-invoice-ready', name: 'Payments: invoice ready',
    subject: 'Your {{brand}} invoice {{invoice.number}} for {{invoice.amount}}',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>Invoice <strong>{{invoice.number}}</strong> for <strong>{{invoice.amount}}</strong> is ready. We will charge the card on file.</p><p><a href="{{url}}">View the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nInvoice {{invoice.number}} for {{invoice.amount}} is ready. We will charge the card on file.\n\nView it: {{url}}',
  },
  {
    key: 'pay-payment-link', name: 'Payments: pay an invoice',
    subject: 'Pay {{brand}} invoice {{invoice.number}} for {{invoice.amount}}',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>Invoice <strong>{{invoice.number}}</strong> for <strong>{{invoice.amount}}</strong> is ready to pay.</p><p><a href="{{url}}">Pay the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nInvoice {{invoice.number}} for {{invoice.amount}} is ready to pay.\n\nPay it: {{url}}',
  },
  {
    key: 'pay-payment-receipt', name: 'Payments: receipt',
    subject: 'Receipt for {{brand}} invoice {{invoice.number}}',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'card', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>We charged <strong>{{invoice.amount}}</strong> to {{card}} for invoice {{invoice.number}}. Thank you.</p><p><a href="{{url}}">View the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nWe charged {{invoice.amount}} to {{card}} for invoice {{invoice.number}}. Thank you.\n\n{{url}}',
  },
  {
    key: 'pay-payment-failed', name: 'Payments: payment failed',
    subject: 'Payment failed for {{brand}} invoice {{invoice.number}}',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'reason', 'next', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>We could not charge <strong>{{invoice.amount}}</strong> for invoice {{invoice.number}}: {{reason}}</p><p>{{next}}</p><p><a href="{{url}}">Update your card or pay the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nWe could not charge {{invoice.amount}} for invoice {{invoice.number}}: {{reason}}\n\n{{next}}\n\n{{url}}',
  },
  {
    key: 'pay-action-required', name: 'Payments: confirm a payment',
    subject: 'Confirm your payment of {{invoice.amount}} to {{brand}}',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>Your bank asks you to confirm the payment of <strong>{{invoice.amount}}</strong> for invoice {{invoice.number}}.</p><p><a href="{{url}}">Confirm the payment</a></p>'),
    text: 'Hi {{account.name}},\n\nYour bank asks you to confirm the payment of {{invoice.amount}} for invoice {{invoice.number}}.\n\n{{url}}',
  },
  {
    key: 'pay-card-expiring', name: 'Payments: card expiring',
    subject: 'Your card ending {{card.last4}} expires soon',
    vars: ['brand', 'account.name', 'card.last4', 'card.expiry', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>The card ending {{card.last4}} that pays for {{brand}} expires at the end of {{card.expiry}}. Add a new card so nothing stops.</p><p><a href="{{url}}">Update your card</a></p>'),
    text: 'Hi {{account.name}},\n\nThe card ending {{card.last4}} that pays for {{brand}} expires at the end of {{card.expiry}}. Add a new card so nothing stops.\n\n{{url}}',
  },
  {
    key: 'pay-refund-receipt', name: 'Payments: refund receipt',
    subject: 'Refund of {{refund.amount}} from {{brand}}',
    vars: ['brand', 'account.name', 'invoice.number', 'refund.amount', 'card', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>We refunded <strong>{{refund.amount}}</strong> to {{card}} for invoice {{invoice.number}}. Banks usually take 5 to 10 business days to show it.</p><p><a href="{{url}}">View the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nWe refunded {{refund.amount}} to {{card}} for invoice {{invoice.number}}. Banks usually take 5 to 10 business days to show it.\n\n{{url}}',
  },
  {
    key: 'pay-account-delinquent', name: 'Payments: account suspended',
    subject: 'Your {{brand}} invoice {{invoice.number}} is unpaid',
    vars: ['brand', 'account.name', 'invoice.number', 'invoice.amount', 'url'],
    html: wrap('<p>Hi {{account.name}},</p><p>After several attempts we could not collect <strong>{{invoice.amount}}</strong> for invoice {{invoice.number}}. Paid services are suspended until it is paid.</p><p><a href="{{url}}">Pay the invoice</a></p>'),
    text: 'Hi {{account.name}},\n\nAfter several attempts we could not collect {{invoice.amount}} for invoice {{invoice.number}}. Paid services are suspended until it is paid.\n\n{{url}}',
  },
];

const KIND_TEMPLATE = {
  'invoice.ready': 'pay-invoice-ready',
  'invoice.payment_link': 'pay-payment-link',
  'payment.succeeded': 'pay-payment-receipt',
  'payment.failed': 'pay-payment-failed',
  'payment.action_required': 'pay-action-required',
  'card.expiring': 'pay-card-expiring',
  'account.delinquent': 'pay-account-delinquent',
  'refund.succeeded': 'pay-refund-receipt',
};

const cardText = (m) => (m ? `${m.display.brand} ending ${m.display.last4}` : 'your card');

/**
 * @param {{ customers?: object, notify?: (kind: string, data: object) => Promise<unknown>, brand: string, billingUrl?: (account) => string|null, log?: object, audit: object }} o
 */
export function createNotifier({ customers, notify, brand, billingUrl = () => null, log, audit }) {
  const ctx = () => customers?.context?.system?.('accel-payments') ?? { system: true };
  let templatesReady = null;

  async function ensureTemplates() {
    const templates = customers?.marketing?.services?.templates;
    if (!templates) return;
    for (const t of PAY_TEMPLATES) {
      let existing = null;
      try {
        existing = await templates.resolve(t.key, ctx());
      } catch (err) {
        if (err.status !== 404 && err.code !== 'not_found') throw err;
      }
      if (existing) continue;
      const created = await templates.create({
        key: t.key, name: t.name, channel: 'email', category: 'transactional',
        variables: t.vars.map((name) => ({ type: 'string', name, required: true, sample: name })),
        locales: [{ locale: 'en', subject: t.subject, bodyHtml: t.html, bodyText: t.text }],
      }, ctx());
      await templates.approve(created.id, ctx());
    }
  }

  /** The variables a template gets for one notice. */
  function dataFor(kind, { account, invoice, method, failure, nextAttemptAt, final, url, refund }) {
    const data = { brand, account: { name: account.name }, url: url ?? billingUrl(account) ?? '' };
    if (invoice) data.invoice = { number: invoice.number ?? invoice.id, amount: format(invoice.amountRemaining ?? invoice.amountDue ?? invoice.total) };
    if (kind === 'payment.succeeded' || kind === 'refund.succeeded') data.card = cardText(method);
    if (refund) data.refund = { amount: format(refund.amount) };
    if (kind === 'payment.failed') {
      data.reason = failure?.message ?? 'the card was declined.';
      data.next = final ? 'That was the last attempt.' : nextAttemptAt ? `We will try again on ${new Date(nextAttemptAt).toUTCString().slice(0, 16)}.` : 'Add a card and we will try again.';
    }
    if (kind === 'card.expiring') data.card = { last4: method.display.last4, expiry: `${String(method.display.expMonth).padStart(2, '0')}/${method.display.expYear}` };
    return data;
  }

  return {
    ensureTemplates: () => (templatesReady ??= ensureTemplates().catch((err) => { templatesReady = null; log?.warn?.(`[accel-payments] email templates: ${err.message}`); })),
    /**
     * @param {keyof KIND_TEMPLATE} kind
     * @param {{ account: object, invoice?: object, method?: object, failure?: object, nextAttemptAt?: string, final?: boolean, url?: string, idempotencyKey: string }} o
     */
    async send(kind, o) {
      const data = dataFor(kind, o);
      try {
        if (notify) {
          await notify(kind, { ...o, data });
        } else if (customers?.marketing?.sendTransactional && o.account.email) {
          await this.ensureTemplates();
          await customers.marketing.sendTransactional({
            template: KIND_TEMPLATE[kind],
            ...(o.account.customerId ? { customerId: o.account.customerId } : { to: o.account.email }),
            data, purpose: 'transactional', idempotencyKey: o.idempotencyKey,
          }, ctx());
        } else {
          return false;
        }
        await audit.record({ action: 'notice.sent', ref: { type: 'account', id: o.account.id }, details: { kind, invoiceId: o.invoice?.id ?? null } });
        return true;
      } catch (err) {
        log?.warn?.(`[accel-payments] ${kind} email failed: ${err.message}`);
        await audit.record({ action: 'notice.failed', ref: { type: 'account', id: o.account.id }, outcome: 'refused', details: { kind, error: err.message } }).catch(() => {});
        return false;
      }
    },
  };
}
