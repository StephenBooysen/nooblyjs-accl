// A Google service account's OAuth access token (developers.google.com/identity/protocols/oauth2/service-account):
// a JWT signed RS256 with the key's private key, traded at its token_uri. node:crypto only; tokens are kept until a
// minute before they expire.
import crypto from 'node:crypto';
import { CloudError } from '../errors.js';

const b64url = (data) => Buffer.from(data).toString('base64url');
export const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Reads a pasted service account key. → { clientEmail, privateKey, projectId, tokenUri } or throws CloudError invalid. */
export function readServiceAccount(credentials) {
  let key = credentials;
  if (typeof key === 'string') {
    try {
      key = JSON.parse(key);
    } catch {
      throw new CloudError('invalid', 'The service account key is not JSON. Paste the whole key file.');
    }
  }
  if (key?.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new CloudError('invalid', 'That is not a service account key: it needs type "service_account", client_email and private_key.');
  }
  return { clientEmail: key.client_email, privateKey: key.private_key, projectId: key.project_id ?? null, tokenUri: key.token_uri ?? 'https://oauth2.googleapis.com/token' };
}

/** → async () => access token */
export function googleToken({ key, fetchImpl = fetch, now = () => Date.now(), scope = SCOPE }) {
  let cached = null;
  return async function token() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.value;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: key.clientEmail, scope, aud: key.tokenUri, iat, exp: iat + 3600 }));
    let signature;
    try {
      signature = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.privateKey).toString('base64url');
    } catch {
      throw new CloudError('invalid', 'The service account key’s private key could not be read. Paste the key file again.');
    }
    let res;
    try {
      res = await fetchImpl(key.tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString(),
      });
    } catch {
      throw new CloudError('unavailable', 'Google’s sign-in service is not answering.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new CloudError('permission', `Google refused the service account key${body.error_description ? `: ${body.error_description}` : ''}. It may have been deleted or disabled.`);
    }
    cached = { value: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
    return cached.value;
  };
}
