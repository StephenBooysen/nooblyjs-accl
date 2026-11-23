// CardForm (spec §9): the provider's hosted card fields in the host's page. The host never sees the card number: on
// the mock provider the fields are a frame served by the accelerator (as Stripe's are served by Stripe); on Stripe they
// are the Payment Element. No framework; the host passes two calls that carry its own session.
//
//   import { mountCardForm } from '/admin/payments/components/card-form.js';
//   const form = mountCardForm(el, {
//     setup: () => api.post('/billing/methods/setup'),            // → { setupId, provider, fieldsUrl?, clientSecret, publishableKey? }
//     confirm: (setupId) => api.post(`/billing/methods/${setupId}/confirm`),   // → the saved card
//     onSaved: (card) => …, onCancel: () => …,
//   });
//   form.destroy();

const STRIPE_JS = 'https://js.stripe.com/v3/';
let stripeLoading = null;

function loadStripe(doc) {
  if (doc.defaultView.Stripe) return Promise.resolve(doc.defaultView.Stripe);
  stripeLoading ??= new Promise((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = STRIPE_JS;
    s.onload = () => resolve(doc.defaultView.Stripe);
    s.onerror = () => { stripeLoading = null; reject(new Error('The card form could not load. Check your connection and try again.')); };
    doc.head.appendChild(s);
  });
  return stripeLoading;
}

function el(doc, tag, attrs = {}, text = null) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== null) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} root
 * @param {object} o
 * @param {() => Promise<object>} o.setup
 * @param {(setupId: string) => Promise<object>} o.confirm
 * @param {(card: object) => void} [o.onSaved]
 * @param {() => void} [o.onCancel]
 * @param {{ save?: string, cancel?: string, note?: string, saving?: string }} [o.labels]
 * @param {{ save?: string, cancel?: string, frame?: string }} [o.classes]
 */
export function mountCardForm(root, { setup, confirm, onSaved = () => {}, onCancel = null, labels = {}, classes = {} }) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const L = { save: 'Save card', cancel: 'Cancel', saving: 'Saving…', note: 'Your card details go straight to our payment provider. We never see or store the card number.', ...labels };
  root.replaceChildren();
  const wrap = el(doc, 'div', { class: 'pay-card-form' });
  const fields = el(doc, 'div', { class: 'pay-card-fields', 'aria-busy': 'true' });
  fields.appendChild(el(doc, 'p', { class: 'pay-card-loading' }, 'Loading the card form…'));
  const error = el(doc, 'p', { class: 'pay-card-error', role: 'alert' });
  const actions = el(doc, 'div', { class: 'pay-card-actions' });
  const save = el(doc, 'button', { type: 'button', class: classes.save ?? 'btn btn-primary', disabled: '' }, L.save);
  actions.appendChild(save);
  if (onCancel) {
    const cancel = el(doc, 'button', { type: 'button', class: classes.cancel ?? 'btn btn-link' }, L.cancel);
    cancel.addEventListener('click', () => onCancel());
    actions.appendChild(cancel);
  }
  wrap.append(fields, error, actions, el(doc, 'p', { class: 'pay-card-note' }, L.note));
  root.appendChild(wrap);

  let session = null;
  let busy = false;
  let destroyed = false;
  let onMessage = null;
  let stripeParts = null;

  const fail = (message) => {
    busy = false;
    save.disabled = false;
    save.textContent = L.save;
    error.textContent = message;
  };
  const done = async () => {
    try {
      const card = await confirm(session.setupId);
      if (destroyed) return;
      busy = false;
      save.textContent = L.save;
      onSaved(card);
    } catch (err) {
      fail(err?.message ?? 'The card could not be saved.');
    }
  };

  (async () => {
    try {
      session = await setup();
      if (destroyed) return;
      fields.replaceChildren();
      if (session.provider === 'mock') {
        const frame = el(doc, 'iframe', { src: session.fieldsUrl, title: 'Card details', class: classes.frame ?? 'pay-card-frame' });
        fields.appendChild(frame);
        onMessage = (e) => {
          if (e.origin !== win.location.origin || e.source !== frame.contentWindow || !e.data?.type) return;
          if (e.data.type === 'pay:mock:ready') { fields.removeAttribute('aria-busy'); save.disabled = false; }
          if (e.data.type === 'pay:mock:result') {
            if (e.data.ok) done();
            else fail(e.data.message ?? 'The card was not accepted.');
          }
        };
        win.addEventListener('message', onMessage);
        save.addEventListener('click', () => {
          if (busy) return;
          busy = true;
          error.textContent = '';
          save.disabled = true;
          save.textContent = L.saving;
          frame.contentWindow.postMessage({ type: 'pay:mock:submit' }, win.location.origin);
        });
      } else if (session.provider === 'stripe') {
        const Stripe = await loadStripe(doc);
        const stripe = Stripe(session.publishableKey);
        const elements = stripe.elements({ clientSecret: session.clientSecret });
        const element = elements.create('payment');
        element.mount(fields);
        element.on('ready', () => { fields.removeAttribute('aria-busy'); save.disabled = false; });
        stripeParts = { stripe, elements, element };
        save.addEventListener('click', async () => {
          if (busy) return;
          busy = true;
          error.textContent = '';
          save.disabled = true;
          save.textContent = L.saving;
          const result = await stripe.confirmSetup({ elements, redirect: 'if_required' });
          if (result.error) fail(result.error.message ?? 'The card was not accepted.');
          else done();
        });
      } else {
        fail('This payment provider has no card form yet.');
      }
    } catch (err) {
      fields.replaceChildren();
      fail(err?.message ?? 'The card form could not load.');
    }
  })();

  return {
    destroy() {
      destroyed = true;
      if (onMessage) win.removeEventListener('message', onMessage);
      stripeParts?.element?.destroy?.();
      root.replaceChildren();
    },
  };
}
