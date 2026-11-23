// A compact OpenAPI 3.1 description of each module's API (spec §7).
const PATHS = {
  payments: [
    ['get', '/accounts', 'List billing accounts'], ['post', '/accounts', 'Create a billing account'],
    ['get', '/accounts:lookup', 'Find an account by externalRef'], ['get', '/accounts/{id}', 'An account'],
    ['patch', '/accounts/{id}', 'Change an account (If-Match: W/"version")'], ['get', '/accounts/{id}/methods', 'Saved cards (display data only)'],
    ['post', '/accounts/{id}/methods:setup', 'Start saving a card: the provider\'s client secret or URL'],
    ['post', '/accounts/{id}/methods/{setupId}:confirm', 'Finish saving a card'], ['post', '/accounts/{id}/methods/{id}:make-default', 'Make a card the default'],
    ['delete', '/accounts/{id}/methods/{id}', 'Remove a card'], ['get', '/accounts/{id}/ledger', 'Ledger entries and balances'],
    ['get', '/payments', 'Payment attempts'], ['get', '/payments/{id}', 'A payment and its refunds'],
    ['get', '/refunds', 'Refunds'], ['post', '/refunds', 'Refund a payment (Idempotency-Key)'],
    ['get', '/dunning', 'Invoices being retried, and written off'], ['get', '/reconciliation/issues', 'Disagreements with the provider'],
    ['post', '/reconciliation/issues/{id}:resolve', 'Mark an issue resolved'], ['get', '/webhooks', 'Provider events received'],
    ['get', '/overview', 'Revenue, open and overdue, failed payments, MRR'],
  ],
  billing: [
    ['get', '/meters', 'Usage meters'], ['post', '/meters', 'Create a meter'], ['get', '/products', 'Products'], ['post', '/products', 'Create a product'],
    ['get', '/prices', 'Prices'], ['post', '/prices', 'Create a price (immutable once used)'], ['patch', '/prices/{id}', 'Activate, deactivate, rename'],
    ['get', '/subscriptions', 'Subscriptions'], ['post', '/subscriptions', 'Subscribe an account (Idempotency-Key)'],
    ['get', '/subscriptions/{id}/preview', 'The next invoice as it stands'],
    ['post', '/subscriptions/{id}:change', 'Change items (prorated)'], ['post', '/subscriptions/{id}:cancel', 'Cancel at period end or now'],
    ['post', '/subscriptions/{id}:pause', 'Pause collection'], ['post', '/subscriptions/{id}:resume', 'Resume collection'],
    ['post', '/usage', 'Record usage (one, or { events: [...] } up to 1,000; idempotent by key)'], ['get', '/accounts/{id}/usage', 'Usage per meter (from, to or period)'],
    ['get', '/accounts/{id}/summary', 'What the BillingSummary component draws'],
    ['get', '/invoices', 'Invoices'], ['post', '/invoices', 'A one-off invoice (Idempotency-Key)'], ['get', '/invoices/{id}', 'An invoice'],
    ['get', '/invoices/{id}.pdf', 'The invoice as a PDF'], ['post', '/invoices/{id}:finalize', 'Finalise a draft'], ['post', '/invoices/{id}:pay', 'Collect now'],
    ['post', '/invoices/{id}:void', 'Void an unpaid invoice'], ['post', '/invoices/{id}:mark-uncollectible', 'Write off'], ['post', '/invoices/{id}/send', 'Email it again'],
    ['get', '/credit-notes', 'Credit notes'], ['post', '/credit-notes', 'Credit (and optionally refund) an invoice (Idempotency-Key)'],
  ],
};

export function openapi(module, S) {
  const paths = {};
  for (const [method, path, summary] of PATHS[module]) {
    paths[path] ??= {};
    paths[path][method] = { summary, responses: { 200: { description: 'OK' }, 422: { description: '{ error: { code, message, details[] } }' } } };
  }
  return {
    openapi: '3.1.0',
    info: { title: `nooblyjs-accel-payments: ${module}`, version: S.version },
    servers: [{ url: `${S.options.basePath}/${module}/api/v1` }],
    paths,
  };
}
