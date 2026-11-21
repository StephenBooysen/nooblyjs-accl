// Caddy on a VM (architecture.md §9, "Endpoints"; roadmap phase 3). Every VM runs Caddy as its HTTPS proxy: the main
// Caddyfile imports one site file per public address from /etc/caddy/sites/, and this file renders those site files
// from endpoint records. Pure functions, so the tests check every line without a VM.
//
// One file per address, not per endpoint: several endpoints may share an address by path ("several apps on one address
// by path", roadmap 3.2), and Caddy refuses the same address defined twice. The endpoints on one address share its
// certificate and its HTTP→HTTPS choice.
//
// Values are checked again here, though the service has already checked them: nothing a person typed reaches a
// Caddyfile unless it is a host name, an IPv4 address, a path of URL-safe segments or a port number.

export const SITES_DIR = '/etc/caddy/sites';
export const CERTS_DIR = '/etc/caddy/certs';
export const ACCESS_LOG = '/var/log/caddy/access.log';
/** Ports an endpoint may not send traffic to: SSH, Caddy's own and its admin API. */
export const RESERVED_PORTS = [22, 80, 443, 2019];

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const PATH = /^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/;
const CERT_ID = /^[a-z]{2,8}_[a-z0-9]{4,32}$/;

export const isHostName = (v) => typeof v === 'string' && HOSTNAME.test(v);
export const isIpv4 = (v) => typeof v === 'string' && IPV4.test(v);
/** '/' or '/blog' or '/docs/v2': no trailing slash, no '..', URL-safe characters only. */
export const isEndpointPath = (v) => typeof v === 'string' && v.length <= 200 && PATH.test(v) && !v.split('/').includes('..');
export const isTrafficPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535 && !RESERVED_PORTS.includes(v);

/** The site file's name for an address: shop.example.com.caddy, 203.0.113.24.caddy. */
export function siteFile(host) {
  if (!isHostName(host) && !isIpv4(host)) throw new Error(`Not an address Caddy can serve: ${JSON.stringify(host)}`);
  return `${host}.caddy`;
}

/** The main Caddyfile cloud-init writes: the ACME email, the admin API on localhost only, and the site files. */
export function mainCaddyfile({ email = null } = {}) {
  if (email !== null && !/^[^\s@{}]+@[^\s@{}]+\.[a-z]{2,}$/i.test(email)) throw new Error('mainCaddyfile: the ACME email is not an email address.');
  return [
    '# Written by Noobly Cloud on first boot. Public addresses are files in /etc/caddy/sites/, one per address.',
    '{',
    ...(email ? [`\temail ${email}`] : []),
    '\tadmin localhost:2019',
    '}',
    '',
    `import ${SITES_DIR}/*.caddy`,
    '',
  ].join('\n');
}

/** A placeholder in the sites folder, so the import matches a file before the first endpoint exists. */
export const PLACEHOLDER_SITE = '# Noobly Cloud keeps one file per public address in this folder.\n';

/**
 * The upstream an endpoint sends traffic to: an app's current container (phase 6 sets `upstreamPort`, its ephemeral
 * host port, on every switch) or the traffic port on the VM itself.
 */
export const upstreamOf = (e) => `127.0.0.1:${e.upstreamPort ?? e.port}`;

/**
 * The site file for one address.
 * @param {string} host   the address (a host name, or the VM's IP for the cloud's address on GCP)
 * @param {object[]} endpoints   the endpoint records on that address (same VM): { id, address: 'cloud'|'domain', path,
 *   port, upstreamPort?, redirectHttp, cert: { source: 'internal'|'letsencrypt'|'upload' } }
 * @returns {string} the Caddyfile text
 */
export function renderSite(host, endpoints) {
  siteFile(host);
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error(`renderSite: ${host} has no endpoints.`);
  const paths = new Set();
  for (const e of endpoints) {
    if (!isEndpointPath(e.path ?? '/')) throw new Error(`renderSite: ${host} has an endpoint with a bad path.`);
    if (!isTrafficPort(e.upstreamPort ?? e.port)) throw new Error(`renderSite: ${host}${e.path} has a bad port.`);
    if (paths.has(e.path ?? '/')) throw new Error(`renderSite: ${host}${e.path ?? '/'} is routed twice.`);
    paths.add(e.path ?? '/');
  }
  // The address's settings come from its first endpoint (the service keeps them the same across its endpoints).
  const lead = [...endpoints].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const cloud = lead.address === 'cloud';
  const source = cloud ? 'internal' : lead.cert?.source ?? 'letsencrypt';
  // A domain redirects HTTP to HTTPS (Caddy's default) unless asked not to; the cloud's address answers on both,
  // because its certificate is self-signed and browsers warn about it.
  const both = cloud || lead.redirectHttp === false;
  const lines = [
    `# Written by Noobly Cloud: ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} on ${host}. Changes here are overwritten.`,
    `${both ? `http://${host}, https://${host}` : host} {`,
  ];
  if (source === 'internal') lines.push('\ttls internal');
  else if (source === 'upload') {
    if (!CERT_ID.test(lead.id)) throw new Error('renderSite: an uploaded certificate needs the endpoint\'s id.');
    lines.push(`\ttls ${CERTS_DIR}/${lead.id}.crt ${CERTS_DIR}/${lead.id}.key`);
  }
  lines.push('\tlog {', `\t\toutput file ${ACCESS_LOG}`, '\t\tformat json', '\t}');
  // Longest path first; Caddy also orders handle blocks by specificity, so the order is for people reading it.
  const ordered = [...endpoints].sort((a, b) => (b.path ?? '/').length - (a.path ?? '/').length || String(a.path).localeCompare(String(b.path)));
  for (const e of ordered) {
    const path = e.path ?? '/';
    if (path === '/') {
      lines.push('\thandle {', `\t\treverse_proxy ${upstreamOf(e)}`, '\t}');
    } else {
      // /blog → /blog/, and /blog/x reaches the app as /x.
      lines.push(`\tredir ${path} ${path}/ 308`, `\thandle_path ${path}/* {`, `\t\treverse_proxy ${upstreamOf(e)}`, '\t}');
    }
  }
  lines.push('}', '');
  return lines.join('\n');
}

/**
 * Groups a VM's endpoints by address and renders each: Map(host → text). Endpoints being removed are left out, so
 * their address disappears when it was their last.
 */
export function renderSites(endpoints) {
  const byHost = new Map();
  for (const e of endpoints) {
    if (e.status === 'removing') continue;
    byHost.set(e.host, [...(byHost.get(e.host) ?? []), e]);
  }
  return new Map([...byHost].map(([host, list]) => [host, renderSite(host, list)]));
}
