// Static sites (spec 8.8) where the platform serves them itself: a local site, or the mock cloud. This is the "mock
// CDN that serves from the mock bucket" of the spec's Design (services.platform.staticSites), made real enough for a LAN: the bucket is this install's
// store, the edge is a small memory cache in front of it, and the launcher's proxy hands requests to respond().
//
// Storage (R2), under static/sites/<tenant>/<site>/:
//   blobs/<aa>/<sha256>          each file's bytes, named by their hash, so a file that did not change between deploys
//                                is kept once
//   deploys/<deployId>.json      a deploy's manifest: path → { sha, size, type }, and its _redirects / _headers rules
//   site.yaml                    { current, deploys: [{ deployId, commit, at, files, bytes }] } newest first
// A deploy is published (blobs, then its manifest) before anything serves it; switching is one write of site.yaml, so
// a request sees the whole old deploy or the whole new one, never a mix. Rollback switches back. The last KEEP deploys
// besides the current one are kept for that; older manifests and the blobs only they used are deleted.
//
// Serving (R4, R5): GET and HEAD. A path is a file, else <path>.html, else <path>/index.html (a redirect to <path>/
// first, so relative links resolve). `_redirects` rules (Netlify's format: `from to [status][!]`, `*` and `:name`)
// apply where no file matches, or always with `!`; status 200 rewrites, 3xx redirects, 404 serves with a 404. With
// `spa`, a path with no file and no extension gets /index.html. Then /404.html, else a plain 404. HTML is `no-cache`;
// a file whose name carries a content hash is cached for a year, `immutable`; anything else for an hour. Every answer
// has an ETag (the file's hash); If-None-Match answers 304. `_headers` adds headers by path. The rule files are never
// served themselves.
//
// Counters (R6) per site since start: requests, bytes sent, and cache hits (an answer from the memory cache, or a 304).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { unpack, cleanPath } from '../../agent/tar.js';

/** Deploys kept for rollback besides the current one (R2). */
export const KEEP = 5;
export const SITE_LIMITS = { files: 20_000, bytes: 250 * 1024 * 1024, path: 1024, redirects: 1000, headers: 200 };
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_FILE_MAX = 4 * 1024 * 1024;

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json', map: 'application/json', txt: 'text/plain; charset=utf-8',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', wasm: 'application/wasm', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  webmanifest: 'application/manifest+json', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
};
const extOf = (p) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase();
export const typeOf = (p) => TYPES[extOf(p)] ?? 'application/octet-stream';
const isHtml = (p) => ['html', 'htm'].includes(extOf(p));
/** A file name that carries a content hash (Vite's index-B3x9_kQa.js, webpack's main.3f2a91c8.css). */
export const isHashed = (p) => {
  const m = /[.-]([A-Za-z0-9_]{8,})\.[A-Za-z0-9]+$/.exec(p.split('/').at(-1) ?? '');
  return Boolean(m && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1]));
};
export function cacheControl(p) {
  if (isHtml(p)) return 'no-cache';
  return isHashed(p) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}
const RULE_FILES = new Set(['_redirects', '_headers']);
/** Headers a `_headers` file may not set: they belong to the platform or to the answer itself. */
const RESERVED = new Set(['set-cookie', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'etag', 'location', 'date', 'server', 'vary', 'content-encoding']);

/** A rule's `from` as a matcher: `*` at the end is the splat, `:name` a segment. → (path) => params | null */
function matcher(from) {
  const splat = from.endsWith('*');
  const parts = (splat ? from.slice(0, -1) : from).split('/');
  return (path) => {
    const segs = path.split('/');
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      const want = parts[i];
      const got = segs[i];
      if (splat && i === parts.length - 1 && want === '') {
        params.splat = segs.slice(i).join('/');
        return params;
      }
      if (got === undefined) return null;
      if (want.startsWith(':') && want.length > 1) {
        if (!got) return null;
        params[want.slice(1)] = got;
      } else if (want !== got) return null;
    }
    if (splat) {
      params.splat = segs.slice(parts.length).join('/');
      return params;
    }
    return segs.length === parts.length ? params : null;
  };
}
const fill = (to, params) => to.replace(/:([A-Za-z]+)/g, (m, k) => (params[k] !== undefined ? params[k] : m));

/**
 * `_redirects`: one rule a line, `from to [status][!]`, # comments. → { rules, problems }
 * from is a path; to is a path or an http(s) URL; status 200 (rewrite), 301 (the default), 302, 303, 307, 308 or 404.
 */
export function parseRedirects(text) {
  const rules = [];
  const problems = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const [from, to, code, ...extra] = line.split(/\s+/);
    const m = /^(\d{3})(!?)$/.exec(code ?? '301');
    const status = m ? Number(m[1]) : NaN;
    const why = !from?.startsWith('/') ? 'The first part is a path starting with /.'
      : !to || !(to.startsWith('/') || /^https?:\/\/[^\s]+$/.test(to)) ? 'The second part is a path or an http(s) URL.'
      : ![200, 301, 302, 303, 307, 308, 404].includes(status) ? 'The status is 200, 301, 302, 303, 307, 308 or 404.'
      : extra.length ? 'Conditions (query, country, role) are not supported.'
      : rules.length >= SITE_LIMITS.redirects ? `Up to ${SITE_LIMITS.redirects} rules.` : null;
    if (why) return problems.push({ line: i + 1, message: why });
    rules.push({ from, to, status, force: m[2] === '!' });
  });
  return { rules, problems };
}

/** `_headers`: a path pattern on its own line, then indented `Name: value` lines. → { rules, problems } */
export function parseHeaders(text) {
  const rules = [];
  const problems = [];
  let current = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    if (!/^\s/.test(raw)) {
      const path = raw.trim();
      if (!path.startsWith('/')) return problems.push({ line: i + 1, message: 'A path starting with /.' });
      if (rules.length >= SITE_LIMITS.headers) return problems.push({ line: i + 1, message: `Up to ${SITE_LIMITS.headers} paths.` });
      current = { path, headers: {} };
      rules.push(current);
      return undefined;
    }
    const m = /^\s+([A-Za-z0-9-]{1,100}):\s*(.{0,2000})$/.exec(raw);
    if (!current || !m) return problems.push({ line: i + 1, message: 'Indented Name: value under a path.' });
    const name = m[1].toLowerCase();
    if (RESERVED.has(name)) return problems.push({ line: i + 1, message: `${m[1]} is set by the platform.` });
    current.headers[name] = m[2].trim();
    return undefined;
  });
  return { rules, problems };
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {() => number} o.now
 * @param {{ warn: Function }} o.log
 */
export function createSites({ store, now = () => Date.now(), log = { warn() {} } }) {
  const iso = () => new Date(now()).toISOString();
  const dir = (t, n) => ['static', 'sites', t, n];
  const siteFile = (t, n) => [...dir(t, n), 'site.yaml'];
  const manifestFile = (t, n, d) => [...dir(t, n), 'deploys', `${d}.json`];
  const blobFile = (t, n, sha) => [...dir(t, n), 'blobs', sha.slice(0, 2), sha];
  const key = (t, n) => `${t}/${n}`;

  /** site → { deployId, manifest } of what it serves (read once per switch). */
  const serving = new Map();
  /** `${site}:${sha}` → Buffer, least recently used first. */
  const cache = new Map();
  let cached = 0;
  /** site → { requests, bytes, hits, since } */
  const counters = new Map();

  const readSite = async (t, n) => (await store.readYaml(siteFile(t, n))) ?? { current: null, deploys: [] };
  async function readManifest(t, n, d) {
    const text = await store.readText(manifestFile(t, n, d));
    return text ? JSON.parse(text) : null;
  }

  function dropCache(prefix) {
    for (const [k, v] of cache) if (k.startsWith(prefix)) { cache.delete(k); cached -= v.length; }
  }
  function remember(k, buf) {
    if (buf.length > CACHE_FILE_MAX) return;
    cache.set(k, buf);
    cached += buf.length;
    for (const [old, v] of cache) {
      if (cached <= CACHE_BYTES) break;
      cache.delete(old);
      cached -= v.length;
    }
  }

  /**
   * A deploy's files into the store (R1, R2). Nothing serves them until setOrigin(). The archive's first folder is the
   * publish directory (`docker cp <c>:/app/dist -`).
   * → { files, bytes, added, skipped, problems }   added: files not kept from an earlier deploy
   */
  async function publish(t, n, deployId, archive) {
    const { files, skipped } = unpack(archive, { stripFirst: true, maxFiles: SITE_LIMITS.files, maxBytes: SITE_LIMITS.bytes, maxPath: SITE_LIMITS.path });
    if (!files.length) throw Object.assign(new Error('The publish directory is empty: check the build command writes the site there.'), { code: 'invalid' });
    const manifest = { deployId, at: iso(), files: {}, redirects: [], headers: [], problems: [] };
    let bytes = 0;
    let added = 0;
    for (const f of files) {
      if (RULE_FILES.has(f.path)) {
        const parsed = f.path === '_redirects' ? parseRedirects(f.data.toString('utf8')) : parseHeaders(f.data.toString('utf8'));
        manifest[f.path === '_redirects' ? 'redirects' : 'headers'] = parsed.rules;
        manifest.problems.push(...parsed.problems.map((p) => ({ file: f.path, ...p })));
        continue;
      }
      const sha = crypto.createHash('sha256').update(f.data).digest('hex');
      if (!(await store.exists(blobFile(t, n, sha)))) {
        await store.writeBuffer(blobFile(t, n, sha), f.data);
        added += 1;
      }
      manifest.files[`/${f.path}`] = { sha, size: f.data.length, type: typeOf(f.path) };
      bytes += f.data.length;
    }
    await store.writeText(manifestFile(t, n, deployId), JSON.stringify(manifest));
    return { files: Object.keys(manifest.files).length, bytes, added, skipped, problems: manifest.problems, redirects: manifest.redirects.length, headers: manifest.headers.length };
  }

  /**
   * Serve `deployId` from now on (R2): one write of site.yaml. Keeps the last KEEP others for rollback, deletes the rest
   * and the blobs only they used. → { current, previous, removed }
   */
  async function setOrigin(t, n, deployId, facts = {}) {
    const manifest = await readManifest(t, n, deployId);
    if (!manifest) throw Object.assign(new Error(`Deploy ${deployId} is not kept any more.`), { code: 'not_found' });
    const result = await store.withLock(siteFile(t, n), async () => {
      const site = await readSite(t, n);
      const previous = site.current;
      const entry = site.deploys.find((d) => d.deployId === deployId)
        ?? { deployId, commit: facts.commit ?? null, at: manifest.at, files: Object.keys(manifest.files).length, bytes: Object.values(manifest.files).reduce((s, f) => s + f.size, 0) };
      const rest = site.deploys.filter((d) => d.deployId !== deployId);
      // A switch to a new deploy puts it first; a rollback keeps the order (the newer ones stay for a roll forward).
      const deploys = site.deploys.some((d) => d.deployId === deployId) ? site.deploys : [entry, ...rest];
      const others = deploys.filter((d) => d.deployId !== deployId);
      const kept = others.slice(0, KEEP);
      const removed = others.slice(KEEP).map((d) => d.deployId);
      const next = { current: deployId, switchedAt: iso(), deploys: deploys.filter((d) => d.deployId === deployId || kept.includes(d)) };
      await store.writeYaml(siteFile(t, n), next);
      return { current: deployId, previous, removed, kept: next.deploys };
    });
    serving.set(key(t, n), { deployId, manifest });
    if (result.removed.length) await cleanUp(t, n, result.removed).catch((err) => log.warn(`static ${t}/${n}: could not clean up: ${err.message}`));
    return result;
  }

  /** Deletes old manifests, then every blob no kept manifest names. */
  async function cleanUp(t, n, removed) {
    for (const d of removed) await store.remove(manifestFile(t, n, d));
    const site = await readSite(t, n);
    const used = new Set();
    for (const d of site.deploys) for (const f of Object.values((await readManifest(t, n, d.deployId))?.files ?? {})) used.add(f.sha);
    for (const aa of (await store.list([...dir(t, n), 'blobs'], { dirs: true })) ?? []) {
      for (const sha of (await store.list([...dir(t, n), 'blobs', aa])) ?? []) {
        if (!used.has(sha)) {
          await store.remove(blobFile(t, n, sha));
          dropCache(`${key(t, n)}:${sha}`);
        }
      }
    }
  }

  /** What a site serves and what it can roll back to. → { current, switchedAt, deploys } */
  async function info(t, n) {
    const site = await readSite(t, n);
    return { current: site.current, switchedAt: site.switchedAt ?? null, deploys: site.deploys };
  }

  async function remove(t, n) {
    serving.delete(key(t, n));
    counters.delete(key(t, n));
    dropCache(`${key(t, n)}:`);
    await store.remove(dir(t, n));
  }

  /** What a site serves: from memory (this process is the only one that switches), else read once from the store. */
  async function current(t, n) {
    const k = key(t, n);
    const hit = serving.get(k);
    if (hit) return hit;
    const site = await readSite(t, n);
    if (!site.current) return null;
    const manifest = await readManifest(t, n, site.current);
    if (!manifest) return null;
    const entry = { deployId: site.current, manifest };
    serving.set(k, entry);
    return entry;
  }

  function count(t, n, { bytes = 0, hit = false }) {
    const c = counters.get(key(t, n)) ?? { requests: 0, bytes: 0, hits: 0, since: iso() };
    c.requests += 1;
    c.bytes += bytes;
    if (hit) c.hits += 1;
    counters.set(key(t, n), c);
  }

  const text = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...extra }, body: Buffer.from(body), hit: false });

  /**
   * One request. `path` is the site's own path (the launcher took its prefix off), `query` the raw query string.
   * → { status, headers, body: Buffer|null, hit, file }   body is null for HEAD and 304
   */
  async function respond(t, n, { method = 'GET', path = '/', query = '', headers = {}, spa = false } = {}) {
    const out = await answer(t, n, { method, path, query, headers, spa });
    if (method === 'HEAD' && out.body) {
      out.headers['content-length'] = String(out.body.length);
      out.body = null;
    }
    count(t, n, { bytes: out.body?.length ?? 0, hit: out.hit });
    return out;
  }

  async function answer(t, n, { method, path, query, headers, spa }) {
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'A static site answers GET and HEAD.', { allow: 'GET, HEAD' });
    const live = await current(t, n);
    if (!live) return text(503, 'This site has no deploy yet.', { 'retry-after': '30' });
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return text(400, 'The path is not valid.');
    }
    const clean = cleanPath(decoded);
    if (clean === null) return text(400, 'The path is not valid.');
    const trailing = decoded.endsWith('/') && clean !== '';
    const p = `/${clean}${trailing ? '/' : ''}`;
    const { manifest } = live;
    const files = manifest.files;
    const qs = query ? `?${query}` : '';

    const fileFor = (q) => {
      if (RULE_FILES.has(q.slice(1))) return null;
      if (q.endsWith('/')) return files[`${q}index.html`] ? `${q}index.html` : null;
      if (files[q]) return q;
      if (files[`${q}.html`]) return `${q}.html`;
      return null;
    };
    const found = fileFor(p);
    const folder = !found && !p.endsWith('/') && files[`${p}/index.html`];

    for (const rule of manifest.redirects ?? []) {
      if ((found || folder) && !rule.force) continue;
      const params = matcher(rule.from)(p);
      if (!params) continue;
      const to = fill(rule.to, params);
      if (rule.status >= 300 && rule.status < 400) {
        return { status: rule.status, headers: { location: /^https?:/.test(to) ? to : `${to}${qs}`, 'cache-control': 'no-cache' }, body: Buffer.alloc(0), hit: false };
      }
      if (/^https?:/.test(to)) continue; // proxying elsewhere is not supported: the rule is skipped
      const target = fileFor(cleanPath(to) === null ? '/' : `/${cleanPath(to)}${to.endsWith('/') ? '/' : ''}`);
      if (target) return serveFile(t, n, live, target, headers, rule.status === 404 ? 404 : 200, p);
    }

    if (found) return serveFile(t, n, live, found, headers, 200, p);
    if (folder) return { status: 301, headers: { location: `${p}/${qs}`, 'cache-control': 'no-cache' }, body: Buffer.alloc(0), hit: false };
    if (spa && !/\.[A-Za-z0-9]{1,8}$/.test(p) && files['/index.html']) return serveFile(t, n, live, '/index.html', headers, 200, p);
    if (files['/404.html']) return serveFile(t, n, live, '/404.html', headers, 404, p);
    return text(404, 'Not found.');
  }

  async function serveFile(t, n, live, file, reqHeaders, status, asked) {
    const f = live.manifest.files[file];
    const etag = `"${f.sha.slice(0, 32)}"`;
    const out = {
      'content-type': f.type,
      'cache-control': status === 200 ? cacheControl(file) : 'no-cache',
      etag,
      'x-content-type-options': 'nosniff',
    };
    for (const rule of live.manifest.headers ?? []) if (matcher(rule.path)(asked) || matcher(rule.path)(file)) Object.assign(out, rule.headers);
    const inm = String(reqHeaders['if-none-match'] ?? '');
    if (status === 200 && inm && inm.split(/\s*,\s*/).some((v) => v === etag || v === `W/${etag}` || v === '*')) {
      return { status: 304, headers: out, body: null, hit: true, file };
    }
    const k = `${key(t, n)}:${f.sha}`;
    let body = cache.get(k);
    const hit = Boolean(body);
    if (body) {
      cache.delete(k); // most recently used goes last
      cache.set(k, body);
    } else {
      body = await fs.readFile(store.resolve(blobFile(t, n, f.sha)));
      remember(k, body);
    }
    return { status, headers: out, body, hit, file };
  }

  return {
    publish,
    setOrigin,
    info,
    remove,
    respond,
    /** Requests, bytes and cache hits since start (R6). */
    stats: (t, n) => ({ ...(counters.get(key(t, n)) ?? { requests: 0, bytes: 0, hits: 0, since: null }) }),
    /** The deploy a site serves now, from memory (no store read): for tests. */
    serving: (t, n) => serving.get(key(t, n))?.deployId ?? null,
  };
}
