// Git hosts (architecture.md §9 "Git connections"; roadmap 6.1, 6.2, 6.9): GitHub and GitLab over their REST APIs with
// fetch (no SDKs), and the mock host used in development and tests. Each client answers the same calls:
//
//   user(token)                         → { login, scopes: [] | null, expiresAt: iso | null }
//   repos(token)                        → [{ fullName, private }]
//   branches(repo, token?)              → ['main', …]
//   commit(repo, branch, token?)        → { sha, message }
//   file(repo, branch, path, token?)    → text, or null when there is no such file
//   addHook(repo, { url, secret, branch }, token)   → { id }
//   removeHook(repo, id, token)
//
// `repo` is what parseRepoUrl() gives. A token is optional for reading a public repository. Errors are GitError with
// a message a person may see; `status` is the host's (401, 403, 404) when it answered.
import crypto from 'node:crypto';

export class GitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * A repository URL: https://host/owner/name(.git) or git@host:owner/name(.git). GitLab allows groups within groups.
 * Returns { provider: 'github' | 'gitlab' | 'other', hostname, owner, name, fullName, cloneUrl } or null.
 */
export function parseRepoUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const s = value.trim();
  if (!s || s.startsWith('-') || /\s/.test(s)) return null;
  let hostname;
  let path;
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(s);
  if (scp) {
    [, hostname, path] = scp;
  } else {
    if (!s.startsWith('https://') || s.includes('%') || s.includes('..')) return null;
    let u;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.username || u.password || u.search || u.hash || u.port) return null;
    hostname = u.hostname;
    path = u.pathname.replace(/^\/+/, '');
  }
  hostname = hostname.toLowerCase();
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2 || parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) return null;
  const provider = hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : 'other';
  if (provider === 'github' && parts.length !== 2) return null;
  const fullName = parts.join('/');
  return { provider, hostname, owner: parts.slice(0, -1).join('/'), name: parts.at(-1), fullName, cloneUrl: `https://${hostname}/${fullName}.git` };
}

/** A branch name git would take (git check-ref-format, the parts we can check without git). */
export function isBranchName(b) {
  return typeof b === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(b) && !b.startsWith('-') && !b.startsWith('/') && !b.endsWith('/')
    && !b.endsWith('.') && !b.endsWith('.lock') && !b.includes('..') && !b.includes('//') && !b.split('/').some((p) => p.startsWith('.'));
}

/** A path inside the repository: ./Dockerfile, docker/web.Dockerfile, . (the context). */
export function isRepoPath(p) {
  return typeof p === 'string' && p.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith('-') && !p.startsWith('/')
    && !p.split('/').includes('..');
}

/**
 * What a Dockerfile says: the final stage's base image and the port it exposes (the final stage's EXPOSE, else any).
 * → { baseImage, port, stages }
 */
export function readDockerfile(text) {
  const lines = String(text ?? '').replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const stages = [];
  for (const line of lines) {
    const [word, ...rest] = line.split(/\s+/);
    const instr = word.toUpperCase();
    if (instr === 'FROM') {
      const args = rest.filter((a) => !a.startsWith('--'));
      const asAt = args.findIndex((a) => a.toUpperCase() === 'AS');
      stages.push({ image: args[0] ?? null, name: asAt > 0 ? args[asAt + 1] ?? null : null, expose: [] });
    } else if (instr === 'EXPOSE' && stages.length) {
      for (const a of rest) {
        const port = Number(String(a).split('/')[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536) stages.at(-1).expose.push(port);
      }
    }
  }
  if (!stages.length) return { baseImage: null, port: null, stages: 0 };
  const last = stages.at(-1);
  // FROM <an earlier stage>: the image is that stage's.
  const base = stages.find((s) => s.name && s.name === last.image && s !== last)?.image ?? last.image;
  return { baseImage: base, port: last.expose[0] ?? stages.flatMap((s) => s.expose)[0] ?? null, stages: stages.length };
}

// ---------------------------------------------------------------- GitHub

function github({ fetchImpl = fetch, base = 'https://api.github.com' } = {}) {
  async function call(path, token, { method = 'GET', body, raw = false, allow = [] } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'noobly-cloud', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allow.includes(res.status)) return { res, body: null };
    if (res.status === 401) throw new GitError(401, 'GitHub does not accept this token: it may have expired or been revoked.');
    if (res.status === 403) throw new GitError(403, 'GitHub refused: the token may not do this here (or the rate limit was reached).');
    if (res.status === 404) throw new GitError(404, 'GitHub has no such repository, or the token cannot see it.');
    if (!res.ok) throw new GitError(502, `GitHub answered ${res.status}. Try again in a moment.`);
    return { res, body: raw ? await res.text() : await res.json() };
  }
  const repoPath = (repo) => `/repos/${repo.fullName}`;
  return {
    async user(token) {
      const { res, body } = await call('/user', token);
      const scopes = res.headers.get('x-oauth-scopes');
      const expiry = res.headers.get('github-authentication-token-expiration');
      return { login: body.login, scopes: scopes === null ? null : scopes.split(',').map((x) => x.trim()).filter(Boolean), expiresAt: expiry ? new Date(expiry.replace(' UTC', 'Z').replace(' ', 'T')).toISOString() : null };
    },
    async repos(token) {
      const { body } = await call('/user/repos?per_page=100&sort=pushed', token);
      return body.map((r) => ({ fullName: r.full_name, private: Boolean(r.private) }));
    },
    async branches(repo, token) {
      const { body } = await call(`${repoPath(repo)}/branches?per_page=100`, token);
      return body.map((b) => b.name);
    },
    async commit(repo, branch, token) {
      const { body } = await call(`${repoPath(repo)}/commits/${encodeURIComponent(branch)}`, token);
      return { sha: body.sha, message: String(body.commit?.message ?? '').split('\n')[0].slice(0, 200) };
    },
    async file(repo, branch, path, token) {
      const { body } = await call(`${repoPath(repo)}/contents/${path.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, token, { allow: [404] });
      if (!body) return null;
      if (Array.isArray(body) || body.type !== 'file') return null;
      return Buffer.from(body.content ?? '', body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    },
    async addHook(repo, { url, secret }, token) {
      const { body } = await call(`${repoPath(repo)}/hooks`, token, { method: 'POST', body: { name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } } });
      return { id: String(body.id) };
    },
    async removeHook(repo, id, token) {
      await call(`${repoPath(repo)}/hooks/${encodeURIComponent(id)}`, token, { method: 'DELETE', allow: [404] });
    },
  };
}

// ---------------------------------------------------------------- GitLab

function gitlab({ fetchImpl = fetch, base = 'https://gitlab.com/api/v4' } = {}) {
  async function call(path, token, { method = 'GET', body, raw = false, allow = [] } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'noobly-cloud', ...(token ? { 'PRIVATE-TOKEN': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allow.includes(res.status)) return { res, body: null };
    if (res.status === 401) throw new GitError(401, 'GitLab does not accept this token: it may have expired or been revoked.');
    if (res.status === 403) throw new GitError(403, 'GitLab refused: the token may not do this here.');
    if (res.status === 404) throw new GitError(404, 'GitLab has no such project, or the token cannot see it.');
    if (!res.ok) throw new GitError(502, `GitLab answered ${res.status}. Try again in a moment.`);
    return { res, body: raw ? await res.text() : await res.json() };
  }
  const project = (repo) => `/projects/${encodeURIComponent(repo.fullName)}`;
  return {
    async user(token) {
      const { body: me } = await call('/user', token);
      const { body: self } = await call('/personal_access_tokens/self', token, { allow: [404] });
      return { login: me.username, scopes: self?.scopes ?? null, expiresAt: self?.expires_at ? new Date(`${self.expires_at}T00:00:00Z`).toISOString() : null };
    },
    async repos(token) {
      const { body } = await call('/projects?membership=true&per_page=100&order_by=last_activity_at', token);
      return body.map((p) => ({ fullName: p.path_with_namespace, private: p.visibility !== 'public' }));
    },
    async branches(repo, token) {
      const { body } = await call(`${project(repo)}/repository/branches?per_page=100`, token);
      return body.map((b) => b.name);
    },
    async commit(repo, branch, token) {
      const { body } = await call(`${project(repo)}/repository/commits/${encodeURIComponent(branch)}`, token);
      return { sha: body.id, message: String(body.title ?? '').slice(0, 200) };
    },
    async file(repo, branch, path, token) {
      const { body } = await call(`${project(repo)}/repository/files/${encodeURIComponent(path.replace(/^\.\//, ''))}/raw?ref=${encodeURIComponent(branch)}`, token, { raw: true, allow: [404] });
      return body;
    },
    async addHook(repo, { url, secret, branch }, token) {
      const { body } = await call(`${project(repo)}/hooks`, token, { method: 'POST', body: { url, token: secret, push_events: true, push_events_branch_filter: branch, enable_ssl_verification: true } });
      return { id: String(body.id) };
    },
    async removeHook(repo, id, token) {
      await call(`${project(repo)}/hooks/${encodeURIComponent(id)}`, token, { method: 'DELETE', allow: [404] });
    },
  };
}

export function gitClients({ fetchImpl = fetch } = {}) {
  return { github: github({ fetchImpl }), gitlab: gitlab({ fetchImpl }) };
}

// ---------------------------------------------------------------- the mock host

const NODE = (port) => `# The storefront\nFROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE ${port}\nCMD ["node", "server.js"]\n`;

/** The mock host's repositories (the seed story's, product.md §9), by provider and full name. */
const MOCK_REPOS = {
  github: {
    'stevie/storefront': { private: true, branches: ['main', 'develop', 'unhealthy', 'broken-build'], dockerfile: NODE(3000) },
    'nooblyjs/blog': { private: false, branches: ['main'], dockerfile: 'FROM nginx:1.27-alpine\nCOPY site/ /usr/share/nginx/html/\nEXPOSE 8080\n' },
    'stevie/orders-api': { private: true, branches: ['main'], dockerfile: 'FROM golang:1.23-bookworm AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /api ./cmd/api\n\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /api /api\nEXPOSE 3000\nENTRYPOINT ["/api"]\n' },
    'stevie/queue-worker': { private: true, branches: ['main'], dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nEXPOSE 8000\nCMD ["python", "worker.py"]\n' },
    'stevie/docs': { private: true, branches: ['main'], dockerfile: NODE(8080) },
    'stevie/admin': { private: true, branches: ['main', 'develop'], dockerfile: NODE(4000) },
    'stevie/no-dockerfile': { private: false, branches: ['main'], dockerfile: null },
  },
  gitlab: {
    'stevie/labs-api': { private: true, branches: ['main'], dockerfile: 'FROM python:3.12-slim\nEXPOSE 5000\nCMD ["gunicorn", "app:app"]\n' },
  },
};
/** Stevie's other repositories, so the connection sees 24 (the mockup's number). */
const FILLER = Array.from({ length: 18 }, (_, i) => `stevie/sandbox-${String(i + 1).padStart(2, '0')}`);

/**
 * The mock Git host. Tokens: mock_github_<user> and mock_gitlab_<user> (scopes for webhooks); mock_github_readonly
 * (cannot add webhooks); mock_github_expired (refused); mock_github_soon (expires in 3 days). Commits are stable per
 * branch until push() moves one; the branch `unhealthy` builds an image whose health check fails and `broken-build`
 * one whose build fails (the mock runner reads that from the commit).
 */
export function createMockGitHost({ now = () => Date.now() } = {}) {
  const heads = new Map();
  const hooks = new Map();
  let hookIds = 100;

  const known = (provider, fullName) => MOCK_REPOS[provider]?.[fullName] ?? null;
  const userOf = (provider, token) => {
    const m = new RegExp(`^mock_${provider}_([a-z0-9-]+)$`).exec(String(token ?? ''));
    return m ? m[1] : null;
  };
  const sha = (seed) => crypto.createHash('sha1').update(seed).digest('hex');
  /** The commit a branch points at: `unhealthy` → dead…, `broken-build` → bad0…, so the mock VM knows what to do. */
  function headOf(provider, fullName, branch) {
    const key = `${provider}:${fullName}@${branch}`;
    if (!heads.has(key)) {
      const h = sha(key);
      const commit = branch === 'unhealthy' ? `dead${h.slice(4)}` : branch === 'broken-build' ? `bad0${h.slice(4)}` : h;
      heads.set(key, { sha: commit, message: `Latest on ${branch}` });
    }
    return heads.get(key);
  }

  function client(provider) {
    const label = provider === 'github' ? 'GitHub' : 'GitLab';
    const see = (repo, token) => {
      const r = known(provider, repo.fullName);
      const user = userOf(provider, token);
      if (token && (user === 'expired' || !user)) throw new GitError(401, `${label} does not accept this token: it may have expired or been revoked.`);
      if (!r || (r.private && !user)) throw new GitError(404, `${label} has no such repository, or the token cannot see it.`);
      return r;
    };
    return {
      async user(token) {
        const user = userOf(provider, token);
        if (!user || user === 'expired') throw new GitError(401, `${label} does not accept this token: it may have expired or been revoked.`);
        const scopes = provider === 'github'
          ? (user === 'readonly' ? ['repo'] : ['repo', 'admin:repo_hook'])
          : (user === 'readonly' ? ['read_repository'] : ['api', 'read_repository']);
        const days = user === 'soon' ? 3 : 60;
        return { login: ['readonly', 'soon'].includes(user) ? 'stevie' : user, scopes, expiresAt: new Date(now() + days * 86_400_000).toISOString() };
      },
      async repos(token) {
        await this.user(token);
        const own = Object.entries(MOCK_REPOS[provider]).map(([fullName, r]) => ({ fullName, private: r.private }));
        return provider === 'github' ? [...own, ...FILLER.map((fullName) => ({ fullName, private: true }))].slice(0, 24) : own;
      },
      async branches(repo, token) {
        return [...see(repo, token).branches];
      },
      async commit(repo, branch, token) {
        if (!see(repo, token).branches.includes(branch)) throw new GitError(404, `${repo.fullName} has no branch ${branch}.`);
        return { ...headOf(provider, repo.fullName, branch) };
      },
      async file(repo, branch, path, token) {
        const r = see(repo, token);
        if (!r.branches.includes(branch)) throw new GitError(404, `${repo.fullName} has no branch ${branch}.`);
        return path.replace(/^\.\//, '') === 'Dockerfile' ? r.dockerfile : null;
      },
      async addHook(repo, { url, secret, branch }, token) {
        see(repo, token);
        if (userOf(provider, token) === 'readonly') throw new GitError(403, `${label} refused: the token may not do this here.`);
        const id = String(hookIds += 1);
        hooks.set(id, { id, provider, fullName: repo.fullName, url, secret, branch });
        return { id };
      },
      async removeHook(repo, id) {
        hooks.delete(String(id));
      },
    };
  }

  return {
    github: client('github'),
    gitlab: client('gitlab'),
    /** Whether the mock answers for this repository (development and tests use only these). */
    knows: (repo) => Boolean(repo && known(repo.provider, repo.fullName)),
    hooks: () => [...hooks.values()].map((h) => ({ ...h })),
    /** What `git clone` on a mock VM finds: { sha, message } or { error } (git's words). */
    clone(url, branch, { token = null } = {}) {
      const repo = parseRepoUrl(url);
      const r = repo && known(repo.provider, repo.fullName);
      if (!r || (r.private && !userOf(repo.provider, token))) return { error: `fatal: could not read Username for 'https://${repo?.hostname ?? 'host'}': terminal prompts disabled` };
      if (!r.branches.includes(branch)) return { error: `fatal: Remote branch ${branch} not found in upstream origin` };
      return { ...headOf(repo.provider, repo.fullName, branch), dockerfile: r.dockerfile };
    },
    /**
     * A push: moves the branch to a new commit and returns what the host would send to each hook, signed:
     * [{ url, headers, body }].
     */
    push(provider, fullName, branch, { message = `Update ${branch}`, pusher = 'stevie', commit } = {}) {
      const next = commit ?? sha(`${fullName}@${branch}:${message}:${now()}:${crypto.randomUUID()}`);
      heads.set(`${provider}:${fullName}@${branch}`, { sha: next, message });
      const deliveries = [];
      for (const h of hooks.values()) {
        if (h.provider !== provider || h.fullName !== fullName) continue;
        const payload = provider === 'github'
          ? { ref: `refs/heads/${branch}`, after: next, deleted: false, repository: { full_name: fullName }, pusher: { name: pusher }, head_commit: { id: next, message } }
          : { object_kind: 'push', ref: `refs/heads/${branch}`, after: next, project: { path_with_namespace: fullName }, user_username: pusher, commits: [{ id: next, message }] };
        const body = JSON.stringify(payload);
        const headers = provider === 'github'
          ? { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': crypto.randomUUID(), 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', h.secret).update(body).digest('hex')}` }
          : { 'Content-Type': 'application/json', 'X-Gitlab-Event': 'Push Hook', 'X-Gitlab-Event-UUID': crypto.randomUUID(), 'X-Gitlab-Token': h.secret };
        deliveries.push({ url: h.url, headers, body });
      }
      return { commit: next, deliveries };
    },
  };
}
