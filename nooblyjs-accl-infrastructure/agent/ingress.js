// Ingress on an ingress pool's VM (spec 8.4): the agent turns the controller's list of sites into Caddy's JSON config
// and loads it through Caddy's admin API on 127.0.0.1:2019, so no Caddyfile text crosses the channel and protocol.js
// checks every host name, upstream and path first. Pure functions here (tested without Caddy); docker.js calls them.
//
// Each site: its host names, its instances' private address:port as upstreams with active health checks (a dead one
// leaves rotation within about 4 s: every 2 s, out after 2 failures, R3) and retries, so a request that meets a dead
// upstream goes to another (R4's zero failed requests). The platform domain's wildcard certificate comes from the DNS-01
// challenge (R2, Design); custom domains get theirs on demand, only when the controller's ask hook says yes (8.4.5). A
// sleeping service (8.4.8) answers with a redirect to the controller's wake hook, which starts it and sends the
// visitor back. Per-host request and byte counters come from Caddy's metrics (R7).

/** The DNS providers the wildcard certificate can use (Caddy built with caddy-dns/googleclouddns or caddy-dns/route53). */
export const DNS_PROVIDERS = ['googleclouddns', 'route53'];

/**
 * @param {object} o
 * @param {{ id: string, hosts: string[], upstreams: string[], health?: { path: string }, sleeping?: boolean }[]} o.sites
 * @param {{ domain: string, provider: string, project?: string, zone?: string } | null} [o.wildcard]
 * @param {string|null} [o.ask]    the controller's on-demand TLS ask URL
 * @param {string|null} [o.wake]   the controller's wake URL (sleeping services)
 * @returns {object} Caddy's JSON config
 */
export function caddyConfig({ sites, wildcard = null, ask = null, wake = null }) {
  const routes = [];
  for (const s of [...sites].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!s.hosts.length) continue;
    let handle;
    if (s.sleeping && wake) {
      handle = [{ handler: 'static_response', status_code: 307, headers: { Location: [`${wake}?host={http.request.host}&path={http.request.uri.path}`], 'Cache-Control': ['no-store'] } }];
    } else if (!s.upstreams.length) {
      handle = [{ handler: 'static_response', status_code: 503, headers: { 'Retry-After': ['5'] }, body: 'This service has no instance running.' }];
    } else {
      handle = [{
        handler: 'reverse_proxy',
        upstreams: [...s.upstreams].sort().map((dial) => ({ dial })),
        load_balancing: { selection_policy: { policy: 'round_robin' }, retries: 2, try_duration: '5s', try_interval: '250ms' },
        health_checks: {
          active: { uri: s.health?.path ?? '/', interval: '2s', timeout: '2s', passes: 1, fails: 2 },
          passive: { fail_duration: '10s', max_fails: 1, unhealthy_status: [502, 503, 504] },
        },
        headers: { request: { set: { 'X-Forwarded-Host': ['{http.request.host}'] } } },
      }];
    }
    routes.push({ '@id': `site-${s.id}`, match: [{ host: [...s.hosts].sort() }], handle, terminal: true });
  }
  routes.push({ handle: [{ handler: 'static_response', status_code: 404, body: 'No service answers on this address.' }] });

  const policies = [];
  if (wildcard) {
    const provider = wildcard.provider === 'route53'
      ? { name: 'route53', ...(wildcard.zone ? { hosted_zone_id: wildcard.zone } : {}) }
      : { name: 'googleclouddns', ...(wildcard.project ? { gcp_project: wildcard.project } : {}) };
    policies.push({ subjects: [`*.${wildcard.domain}`, wildcard.domain], issuers: [{ module: 'acme', challenges: { dns: { provider } } }] });
  }
  if (ask) policies.push({ on_demand: true, issuers: [{ module: 'acme' }] });

  return {
    admin: { listen: '127.0.0.1:2019' },
    apps: {
      http: {
        servers: {
          noobly: {
            listen: [':443', ':80'],
            routes,
            automatic_https: { prefer_wildcard: Boolean(wildcard) },
            metrics: { per_host: true },
          },
        },
      },
      tls: {
        ...(wildcard ? { certificates: { automate: [`*.${wildcard.domain}`] } } : {}),
        automation: { policies, ...(ask ? { on_demand: { permission: { module: 'http', endpoint: ask } } } : {}) },
      },
    },
  };
}

/** Per-host totals from Caddy's Prometheus metrics: { [host]: { requests, bytesOut, errors } } (5xx in errors). */
export function parseMetrics(text) {
  const out = {};
  const row = (host) => (out[host] ??= { requests: 0, bytesOut: 0, errors: 0 });
  for (const line of String(text).split('\n')) {
    const m = /^(caddy_http_requests_total|caddy_http_response_size_bytes_sum|caddy_http_request_duration_seconds_count)\{([^}]*)\}\s+([0-9.eE+-]+)$/.exec(line.trim());
    if (!m) continue;
    const labels = Object.fromEntries([...m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (!labels.host || labels.server !== 'noobly') continue;
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'caddy_http_requests_total') row(labels.host).requests += v;
    else if (m[1] === 'caddy_http_response_size_bytes_sum') row(labels.host).bytesOut += v;
    else if (/^5\d\d$/.test(labels.code ?? '')) row(labels.host).errors += v;
  }
  return out;
}
