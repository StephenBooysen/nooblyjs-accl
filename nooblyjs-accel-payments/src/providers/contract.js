// The provider contract (spec §5). Every provider (mock, Stripe, later Paystack) has these functions; card data only
// ever reaches the provider's hosted fields, and we keep its tokens and display data (brand, last 4, expiry).

export const PROVIDER_SHAPE = {
  customers: ['create', 'update'],
  methods: ['createSetup', 'confirmSetup', 'detach'],
  charges: ['create', 'get'],
  refunds: ['create', 'get'],
  webhooks: ['verify', 'parse'],
  balance: ['transactions'],
};

/** The functions a provider object lacks ([] when it is complete). */
export function missingFunctions(provider) {
  const missing = [];
  if (!provider || typeof provider.name !== 'string') missing.push('name');
  for (const [group, fns] of Object.entries(PROVIDER_SHAPE)) {
    for (const fn of fns) if (typeof provider?.[group]?.[fn] !== 'function') missing.push(`${group}.${fn}`);
  }
  return missing;
}

/**
 * Normalised webhook event types every provider's parse() maps to:
 *   charge.succeeded | charge.failed | charge.requires_action   { chargeRef, failure? }
 *   refund.succeeded                                             { refundRef, chargeRef, amount }
 *   dispute.created                                              { chargeRef, amount, reason }
 *   method.updated                                               { methodRef, display }
 *   other                                                        { providerType }
 */
export const WEBHOOK_TYPES = ['charge.succeeded', 'charge.failed', 'charge.requires_action', 'refund.succeeded', 'dispute.created', 'method.updated', 'other'];
