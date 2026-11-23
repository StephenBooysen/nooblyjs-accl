// The hosted checkout's card form (billing/checkout.js draws the page): the provider's hosted fields through CardForm,
// then the invoice is paid with the card just added. On the receipt, the countdown back to the host's app.
import { mountCardForm } from '../../components/card-form.js';

const errorBox = document.getElementById('pay-co-error');

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? 'The payment did not go through. Try again.');
  return json;
}

function mount(root) {
  const { token, due } = root.dataset;
  const base = `${encodeURIComponent(token)}`;
  let form = null;
  const start = () => {
    form?.destroy();
    form = mountCardForm(root, {
      setup: () => post(`${base}/setup`, {}),
      // Saving the card and paying are one step here: the answer says what happened to the payment.
      confirm: (setupId) => post(`${base}/pay`, { setupId, save: document.getElementById('pay-co-save')?.checked !== false }),
      onSaved: (result) => {
        if (result.status === 'paid') window.location.reload();
        else if (result.actionUrl) window.location.assign(result.actionUrl);
        else {
          errorBox.textContent = result.message ?? 'The card was not charged. Try another card.';
          start();
        }
      },
      labels: { save: `Pay ${due}`, saving: 'Paying…' },
      classes: { save: 'pay-co-submit', frame: 'pay-co-frame' },
    });
  };
  start();
}

const checkout = document.getElementById('pay-checkout');
if (checkout) mount(checkout);

const countdown = document.getElementById('pay-co-countdown');
if (countdown) {
  let left = 5;
  const tick = () => {
    left -= 1;
    if (left <= 0) window.location.assign(countdown.dataset.return);
    else {
      countdown.textContent = countdown.textContent.replace(/\d+ seconds?/, `${left} second${left === 1 ? '' : 's'}`);
      setTimeout(tick, 1000);
    }
  };
  setTimeout(tick, 1000);
}
