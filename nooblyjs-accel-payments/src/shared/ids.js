// Prefixed ids (acct_…, in_…): 16 characters of crypto randomness in lower-case base32.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function randomToken(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] & 31];
  return out;
}

export const newId = (prefix) => `${prefix}_${randomToken(16)}`;

/** A signed, URL-safe token for public links (hosted invoices, 3-D Secure hand-offs): `<payload>.<mac>`. */
export function signToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
  return `${body}.${mac}`;
}

/** The payload of a token signed with `secret`, or null (bad signature, malformed, or expired `exp`). */
export function readToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && now > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
