// Errors as the API sends them: { error: { code, message, details[] } } (steering §6). A PayError's message is safe to
// show; anything else is a fault, and its message never leaves the server.

export class PayError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

/** A provider's refusal, mapped to a plain, client-safe reason (spec §5). */
export class ProviderError extends PayError {
  /** @param {'card_declined'|'authentication_required'|'insufficient_funds'|'expired_card'|'invalid'|'unavailable'|'no_payment_method'} reason */
  constructor(reason, message, { providerCode = null } = {}) {
    super(reason === 'unavailable' ? 503 : 402, reason, message ?? PROVIDER_MESSAGES[reason] ?? 'The payment provider refused the request.');
    this.reason = reason;
    this.providerCode = providerCode;
  }
}

export const PROVIDER_MESSAGES = {
  card_declined: 'The card was declined.',
  authentication_required: 'The bank asks the cardholder to confirm this payment.',
  insufficient_funds: 'The card has insufficient funds.',
  expired_card: 'The card has expired.',
  invalid: 'The payment provider could not accept the details.',
  unavailable: 'The payment provider is not answering. Try again in a few minutes.',
  no_payment_method: 'There is no card on file.',
};

export const invalid = (message, details = []) => new PayError(422, 'invalid', message, details);
export const notFound = (what = 'That record') => new PayError(404, 'not_found', `${what} was not found.`);
export const conflict = (message, details = []) => new PayError(409, 'conflict', message, details);
export const forbidden = (message = 'You do not have permission to do that.') => new PayError(403, 'forbidden', message);
export const unauthorised = () => new PayError(401, 'unauthorised', 'Sign in first.');
export const preconditionFailed = (message = 'The record changed since you read it. Load it again.') => new PayError(412, 'precondition_failed', message);

/** Collects field problems and throws one invalid error with all of them. */
export function checker() {
  const details = [];
  return {
    details,
    fail(path, message) { details.push({ path, message }); },
    throwIfAny(message = 'Some fields need attention.') { if (details.length) throw invalid(message, details); },
  };
}
