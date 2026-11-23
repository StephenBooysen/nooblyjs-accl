// The mock provider's hosted card fields, inside the card form's frame. The card number goes from here to the mock
// provider (POST setups) and nowhere else; the page that holds the frame only hears "saved" and the display data.
(function () {
  'use strict';
  var form = document.getElementById('pay-fields');
  var error = document.getElementById('pay-error');
  var secret = new URLSearchParams(location.search).get('secret') || '';
  function tell(msg) { if (window.parent !== window) window.parent.postMessage(msg, location.origin); }
  var exp = document.getElementById('pay-exp');
  exp.addEventListener('input', function () {
    var d = exp.value.replace(/\D/g, '').slice(0, 4);
    exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  });
  var busy = false;
  function submit() {
    if (busy) return;
    busy = true;
    error.textContent = '';
    fetch('setups', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ secret: secret, number: form.number.value, exp: form.exp.value, cvc: form.cvc.value })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      busy = false;
      if (r.ok) { form.number.value = ''; form.cvc.value = ''; tell({ type: 'pay:mock:result', ok: true, display: r.body.display }); }
      else { error.textContent = (r.body.error && r.body.error.message) || 'The card was not accepted.'; tell({ type: 'pay:mock:result', ok: false, message: error.textContent }); }
    }).catch(function () {
      busy = false;
      error.textContent = 'The card could not be checked. Try again.';
      tell({ type: 'pay:mock:result', ok: false, message: error.textContent });
    });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'pay:mock:submit') return;
    submit();
  });
  tell({ type: 'pay:mock:ready', height: document.documentElement.scrollHeight });
})();
