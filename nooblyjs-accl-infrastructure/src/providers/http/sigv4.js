// AWS Signature Version 4 (docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html), with node:crypto
// only: the AWS adapter talks to EC2, STS, SSM, CloudWatch and ECR over plain HTTPS, without an SDK.
import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** 20150830T123600Z */
export const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Signs a request. → the headers to send (the ones given, plus x-amz-date, x-amz-security-token when the credentials
 * are temporary, and authorization).
 * @param {object} o
 * @param {string} o.method
 * @param {string} o.url
 * @param {Record<string, string>} [o.headers]
 * @param {string} [o.body]
 * @param {string} o.service    e.g. ec2, sts, ssm, monitoring, ecr
 * @param {string} o.region
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} o.credentials
 * @param {Date} [o.date]
 */
export function signRequest({ method, url, headers = {}, body = '', service, region, credentials, date = new Date() }) {
  const u = new URL(url);
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': stamp, ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}) };
  const lower = Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = lower.map(([k]) => k).join(';');
  const query = [...u.searchParams].map(([k, v]) => [encode(k), encode(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = u.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';
  const canonical = [method, path, query, lower.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const out = { ...headers, 'x-amz-date': stamp };
  if (credentials.sessionToken) out['x-amz-security-token'] = credentials.sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
