// The 3-D Secure hand-off with Stripe: Stripe.js opens the bank's check for the PaymentIntent, then the page tells the
// accelerator to read the payment again.
(function () {
  'use strict';
  var el = document.getElementById('pay-action');
  if (!el || typeof window.Stripe !== 'function') return;
  var stripe = window.Stripe(el.dataset.publishableKey);
  function complete(result) {
    var form = document.createElement('form');
    form.method = 'post';
    form.action = el.dataset.complete;
    var input = document.createElement('input');
    input.type = 'hidden'; input.name = 'result'; input.value = result;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }
  stripe.handleNextAction({ clientSecret: el.dataset.clientSecret }).then(function (r) {
    complete(r.error ? 'fail' : 'succeed');
  });
})();
