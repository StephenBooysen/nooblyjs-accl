// Git connections and reading repositories (architecture.md §9 "Git connections", D11; product.md §6.11; roadmap 6.1,
// 6.2). An Owner adds a GitHub or GitLab personal access token: it is checked on save (whose it is, its scopes, when
// it expires, how many repositories it sees) and daily, and kept in secrets; the record holds only its ref. The token
// lists repositories, reads a Dockerfile through the host's API (POST /git/check: nothing is cloned on this server),
// clones private repositories on the VM (apps.js) and adds or removes an app's webhook.
//
// Tokens that start with mock_ talk to the mock host (as mock cloud accounts do). With `mock` on (development and
// tests), the mock also answers for the public repositories it knows, so nothing leaves the machine.
//
// Who may: adding, testing and removing a connection need `change-guardrails` (Owner); checking a repository needs
// `draft` (product.md §7).
import { unprocessable, notFound } from '../util/errors.js';
import { needs } from '../util/http.js';
import { isResourceName } from '../util/ids.js';
import { who } from './operations.js';
import { GitError, gitClients, createMockGitHost, parseRepoUrl, isBranchName, isRepoPath, readDockerfile } from '../git/hosts.js';

export const GIT_PROVIDERS = { github: 'GitHub', gitlab: 'GitLab' };
const DAY = 86_400_000;
/** A token this close to its expiry needs attention (product.md §6.11). */
const SOON_MS = 7 * DAY;
/** What each host needs from a token, in words for the form (architecture.md §9). */
export const TOKEN_HELP = {
  github: 'A fine-grained token with Contents: read, Metadata: read and Webhooks: read and write on the repositories, or a classic token with repo and admin:repo_hook.',
  gitlab: 'A token with read_repository and api (api adds the webhooks).',
};
const HOOK_SCOPES = { github: ['admin:repo_hook', 'write:repo_hook'], gitlab: ['api'] };

export function createGit({ repos, host, secrets, mock = false, fetchImpl = fetch, now = () => Date.now(), log }) {
  const iso = () => new Date(now()).toISOString();
  const real = gitClients({ fetchImpl });
  const mockHost = createMockGitHost({ now });
  const emit = (type, c, extra = {}, actor = null) => host.events.emit(type, { resource: { type: 'git', name: c.id }, provider: c.provider, user: c.user, ...extra }, { actor });

  const isMockToken = (token) => typeof token === 'string' && token.startsWith('mock_');
  /** The client for a provider and token (or for a repository read without one). */
  const clientFor = (provider, token, repo = null) => ((isMockToken(token) || (!token && mock && mockHost.knows(repo))) ? mockHost[provider] : real[provider]);

  /** What a connection may do and whether it needs attention. */
  function stateOf(c, { scopes, expiresAt }) {
    const problems = [];
    if (expiresAt && Date.parse(expiresAt) <= now()) problems.push(`The token expired on ${expiresAt.slice(0, 10)}.`);
    else if (expiresAt && Date.parse(expiresAt) - now() < SOON_MS) problems.push(`The token expires on ${expiresAt.slice(0, 10)}. Add a new one before then.`);
    const hooks = scopes === null ? null : HOOK_SCOPES[c.provider].some((s) => scopes.includes(s));
    if (hooks === false) problems.push(`It cannot add webhooks (it needs ${HOOK_SCOPES[c.provider][0]}), so pushes will not redeploy.`);
    return { state: problems.length ? 'needs-attention' : 'connected', problem: problems.join(' ') || null, canHook: hooks !== false };
  }

  function view(c, apps = []) {
    const using = apps.filter((a) => a.source?.gitConnection === c.id).map((a) => a.name);
    return {
      id: c.id, provider: c.provider, providerLabel: GIT_PROVIDERS[c.provider], user: c.user, scopes: c.scopes ?? null,
      expiresAt: c.expiresAt ?? null, repoCount: c.repoCount ?? null, state: c.state, problem: c.problem ?? null, canHook: c.canHook !== false,
      checkedAt: c.checkedAt ?? null, createdAt: c.createdAt, createdBy: c.createdBy ?? null, apps: using,
    };
  }

  async function mustGet(id) {
    const c = isResourceName(id) ? await repos.gitConnections.get(id) : null;
    if (!c) throw notFound(`No Git connection ${id}.`);
    return c;
  }

  /** Asks the host who the token is; → the facts kept on the record. Throws 422 when the host refuses it. */
  async function inspect(provider, token) {
    const client = clientFor(provider, token);
    try {
      const me = await client.user(token);
      const list = await client.repos(token);
      return { user: me.login, scopes: me.scopes, expiresAt: me.expiresAt, repoCount: list.length };
    } catch (err) {
      if (err instanceof GitError) throw unprocessable(err.message, { fields: { token: err.message } });
      throw err;
    }
  }

  const tokenOf = async (c) => (c?.tokenRef ? secrets.get(c.tokenRef) : null);

  /** The connection to read `repo` with: the one named, else none (a public repository). */
  async function access(repo, connectionId) {
    if (!connectionId) return { client: clientFor(repo.provider, null, repo), token: null, connection: null };
    const c = await repos.gitConnections.get(connectionId);
    if (!c) throw unprocessable(`The Git connection ${connectionId} is gone. Pick another, or none for a public repository.`, { fields: { gitConnection: 'Pick another connection.' } });
    if (c.provider !== repo.provider) throw unprocessable(`${connectionId} is a ${GIT_PROVIDERS[c.provider]} connection; this repository is on ${repo.hostname}.`, { fields: { gitConnection: `Pick a ${repo.provider === 'other' ? 'matching' : GIT_PROVIDERS[repo.provider]} connection, or none.` } });
    const token = await tokenOf(c);
    return { client: clientFor(repo.provider, token, repo), token, connection: c };
  }

  return {
    TOKEN_HELP,
    mockHost,
    parseRepoUrl,

    async list() {
      const apps = await repos.apps.list();
      return (await repos.gitConnections.list()).sort((a, b) => a.id.localeCompare(b.id)).map((c) => view(c, apps));
    },

    async get(id) {
      return view(await mustGet(id), await repos.apps.list());
    },

    /** Adds a connection: { provider, token }. The token is checked before anything is kept. */
    async add(body, person) {
      await needs(host, person, 'change-guardrails', 'add a Git connection');
      const provider = body?.provider;
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const fields = {};
      if (!GIT_PROVIDERS[provider]) fields.provider = 'Pick GitHub or GitLab.';
      if (!token) fields.token = 'Paste the personal access token.';
      else if (token.length > 255 || /\s/.test(token)) fields.token = 'That does not look like a token.';
      if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields.', { fields });
      const facts = await inspect(provider, token);
      let id = `${provider}-${String(facts.user).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60).replace(/-+$/, '');
      if (!isResourceName(id)) id = `${provider}-token`;
      for (let n = 2; await repos.gitConnections.get(id); n += 1) id = `${id.replace(/-\d+$/, '')}-${n}`;
      const tokenRef = await secrets.put('git-token', token);
      const record = { id, provider, ...facts, tokenRef, ...stateOf({ provider }, facts), checkedAt: iso(), createdAt: iso(), createdBy: who(person) };
      await repos.gitConnections.write(record);
      await emit('infrastructure.git.connected', record, { label: GIT_PROVIDERS[provider] }, person?.id);
      return view(record);
    },

    /** Checks a connection again now (the daily job does the same for every one). */
    async test(id, person) {
      if (person) await needs(host, person, 'change-guardrails', 'test a Git connection');
      const c = await mustGet(id);
      let patch;
      try {
        const facts = await inspect(c.provider, await tokenOf(c));
        patch = { ...facts, ...stateOf(c, facts) };
      } catch (err) {
        if (err.status !== 422) throw err;
        patch = { state: 'failed', problem: err.message, canHook: false };
      }
      const next = await repos.gitConnections.update(id, (r) => r && { ...r, ...patch, checkedAt: iso() });
      if (next.state !== 'connected' && c.state === 'connected') await emit('infrastructure.git.needs_attention', next, { reason: next.problem });
      return view(next, await repos.apps.list());
    },

    /** Removes a connection; apps that use it keep running but can't redeploy until they get another. */
    async remove(id, person) {
      await needs(host, person, 'change-guardrails', 'remove a Git connection');
      const c = await mustGet(id);
      if (c.tokenRef) await secrets.remove(c.tokenRef);
      await repos.gitConnections.remove(id);
      await emit('infrastructure.git.removed', c, {}, person?.id);
      return { removed: id };
    },

    /** The daily check of every connection. */
    async checkAll() {
      for (const c of await repos.gitConnections.list()) {
        try {
          await this.test(c.id);
        } catch (err) {
          log.warn(`git connection ${c.id}: ${err.message}`);
        }
      }
    },

    /**
     * POST /git/check: reads the Dockerfile through the host's API. → { found, baseImage, port, branches, commit } or
     * { found: false, message }. A host we can't read (not GitHub or GitLab) gets found: null; the build will tell.
     */
    async check(body, person) {
      await needs(host, person, 'draft', 'check a repository');
      const fields = {};
      const repo = parseRepoUrl(body?.repo);
      if (!repo) fields.repo = 'An https:// URL such as https://github.com/stevie/storefront.git, or git@github.com:stevie/storefront.git.';
      const branch = body?.branch ?? null;
      if (branch !== null && branch !== '' && !isBranchName(branch)) fields.branch = 'A branch name such as main.';
      const dockerfile = body?.dockerfile || './Dockerfile';
      if (!isRepoPath(dockerfile)) fields.dockerfile = 'A path inside the repository, such as ./Dockerfile.';
      if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields.', { fields });
      if (repo.provider === 'other') return { found: null, message: `We can read Dockerfiles from GitHub and GitLab. ${repo.hostname} is cloned on the VM and the build reads it there.` };
      const { client, token, connection } = await access(repo, body.gitConnection || null);
      try {
        const branches = await client.branches(repo, token);
        const pick = branch || (branches.includes('main') ? 'main' : branches[0]);
        if (!branches.includes(pick)) return { found: false, branches, message: `${repo.fullName} has no branch ${pick}.` };
        const [text, commit] = await Promise.all([client.file(repo, pick, dockerfile, token), client.commit(repo, pick, token)]);
        if (text === null) return { found: false, branches, branch: pick, commit, message: `No ${dockerfile} on ${pick}. Apps are built from a Dockerfile.` };
        const facts = readDockerfile(text);
        return { found: true, branches, branch: pick, commit, ...facts, private: Boolean(token), connection: connection?.id ?? null };
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        if (err.status === 404 && !token) return { found: false, message: `${repo.fullName} is private, or not there. Pick a Git connection that can see it.` };
        return { found: false, message: err.message };
      }
    },

    /** The token to clone with (on the VM, through GIT_ASKPASS), or null for a public repository. */
    async cloneToken(connectionId) {
      if (!connectionId) return null;
      const c = await repos.gitConnections.get(connectionId);
      if (!c) throw new GitError(409, `The Git connection ${connectionId} was removed. Give the app another one to redeploy it.`);
      return tokenOf(c);
    },

    /** The branch's latest commit, when the host can tell (else null: the clone finds it). */
    async latest(repoUrl, branch, connectionId) {
      const repo = parseRepoUrl(repoUrl);
      if (!repo || repo.provider === 'other') return null;
      try {
        const { client, token } = await access(repo, connectionId);
        return await client.commit(repo, branch, token);
      } catch (err) {
        if (err instanceof GitError || err.status === 422) return null;
        throw err;
      }
    },

    /** Adds an app's webhook. → { id } or throws GitError / 422 with the reason. */
    async addHook(app, { url, secret }) {
      const repo = parseRepoUrl(app.source.repo);
      if (!repo || repo.provider === 'other') throw new GitError(400, `We can add webhooks on GitHub and GitLab, not ${repo?.hostname ?? 'this host'}.`);
      if (!app.source.gitConnection) throw new GitError(400, `Adding a webhook needs a Git connection that can see ${repo.fullName}.`);
      const { client, token, connection } = await access(repo, app.source.gitConnection);
      if (connection.canHook === false) throw new GitError(403, `${connection.id} cannot add webhooks: ${connection.problem}`);
      return client.addHook(repo, { url, secret, branch: app.source.branch }, token);
    },

    async removeHook(app) {
      const repo = parseRepoUrl(app.source?.repo);
      if (!repo || !app.webhook?.id || !app.source.gitConnection) return;
      try {
        const { client, token } = await access(repo, app.source.gitConnection);
        await client.removeHook(repo, app.webhook.id, token);
      } catch (err) {
        log.warn(`removing the webhook of ${app.name}: ${err.message}`);
      }
    },

    /** The seed story's connections get their mock tokens (secrets can't be written as seed files). */
    async seedTokens() {
      for (const c of await repos.gitConnections.list()) {
        if (c.tokenRef || !c.seedToken) continue;
        const tokenRef = await secrets.put('git-token', c.seedToken);
        await repos.gitConnections.update(c.id, (r) => r && { ...r, tokenRef, seedToken: undefined });
      }
    },
  };
}
