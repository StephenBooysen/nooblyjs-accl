// Apps: a Dockerfile in Git, built and run on one of your VMs behind its Caddy (product.md §6.5, §6.6, §6.11;
// architecture.md §9 "Deploy", "Linked env vars", "Auto-deploy"; roadmap 6.3, 6.4, 6.7, 6.9).
//
// A deploy is the operation app.deploy, on the VM (so it never races the VM's endpoints for Caddy), in nine steps:
// check the source, clone, build, write the environment, start the new container beside the old one, check its health,
// switch the endpoint to it, stop the old one, prune old images. A failed health check removes the new container and
// leaves the old one serving. Each deploy is a record (apps/<app>/deploys/<id>.md) whose body is its log.
//
// Environment values: plain ones are kept on the app; secret ones in secrets (the app holds refs); linked ones are
// resolved at deploy time (a database's connection string, a bucket's name and access keys). They reach the VM in a
// 0600 file sent over SFTP, never a command line, and never come back to the browser.
//
// Who may: deploy, redeploy, stop and start need `draft`; delete needs `approve` and a person (product.md §7).
import crypto from 'node:crypto';
import { HttpError, notFound, unprocessable, conflict } from '../util/errors.js';
import { needs, peopleOnly } from '../util/http.js';
import { newId, isResourceName, isGeneratedId, isBucketName } from '../util/ids.js';
import { CloudError, isCloudError } from '../providers/errors.js';
import { who } from './operations.js';
import { GitError, parseRepoUrl, isBranchName, isRepoPath } from '../git/hosts.js';
import { isHostName, isEndpointPath } from '../remote/caddy.js';
import { CLOUD } from './event-words.js';

export const APP_OPERATIONS = ['app.deploy', 'app.stop', 'app.start', 'app.delete'];
export const RESTART_POLICIES = { always: 'always', 'on-failure': 'on-failure', never: 'no' };
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV = 100;
const HEALTH_TIMEOUT_S = 60;
const KEEP_IMAGES = 2;
const ACTIVE = new Set(['queued', 'running']);
const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

const DEPLOY_STEPS = [
  ['source', 'Check the source'],
  ['clone', 'Clone the repository'],
  ['build', 'Build the image'],
  ['env', 'Write the environment'],
  ['start', 'Start the container'],
  ['health', 'Check health'],
  ['switch', 'Go live on HTTPS'],
  ['retire', 'Stop the previous version'],
  ['prune', 'Clean up old images'],
];

export function createApps({ repos, host, operations, remote, endpoints, git, secrets, publicUrl = () => null, mountPath = '/infrastructure', now, log }) {
  const iso = () => new Date(now()).toISOString();
  const emit = (type, payload, actor = null) => host.events.emit(type, { resource: { type: 'app', name: payload.app }, ...payload }, { actor });
  const parse = (result) => {
    try {
      return JSON.parse(String(result.stdout ?? '').trim().split('\n').pop());
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- reading

  async function mustGet(name) {
    const app = isResourceName(name) ? await repos.apps.get(name) : null;
    if (!app) throw notFound(`No app ${name}.`);
    return app;
  }

  /** The app operations queued or running, by app name (the op's resource is the VM; input.app names the app). */
  async function activeByApp() {
    const out = new Map();
    for (const op of await repos.operations.list()) {
      if (!APP_OPERATIONS.includes(op.type) || !ACTIVE.has(op.status) || !op.input?.app) continue;
      const prev = out.get(op.input.app);
      if (!prev || (op.status === 'running' && prev.status !== 'running')) out.set(op.input.app, op);
    }
    return out;
  }

  function statusOf(app, vm, op) {
    if (op?.type === 'app.deploy') {
      const at = op.steps.findIndex((s) => s.status === 'running');
      const n = at >= 0 ? at + 1 : Math.max(1, op.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length);
      return { key: 'building', text: op.status === 'queued' ? 'Building · queued' : `Building · step ${n} of ${op.steps.length}`, tone: 'warning', step: n };
    }
    if (op) return { key: op.type.slice(4), text: { 'app.stop': 'Stopping', 'app.start': 'Starting', 'app.delete': 'Deleting' }[op.type], tone: 'warning' };
    if (vm && vm.status !== 'running' && ['live', 'crashed', 'stopped'].includes(app.status)) return { key: 'stopped-with-vm', text: 'Stopped with VM', tone: 'neutral' };
    return {
      live: { key: 'live', text: 'Live', tone: 'success' },
      failed: { key: 'failed', text: 'Failed', tone: 'danger' },
      crashed: { key: 'crashed', text: 'Crashed', tone: 'danger' },
      stopped: { key: 'stopped', text: 'Stopped', tone: 'neutral' },
      building: { key: 'building', text: 'Building', tone: 'warning' },
    }[app.status] ?? { key: app.status, text: app.status, tone: 'neutral' };
  }

  function endpointOf(app, vm, eps) {
    const e = eps.find((x) => x.app === app.name);
    if (!e) return null;
    const path = e.path && e.path !== '/' ? e.path : '';
    return {
      id: e.id, host: e.host, path: e.path ?? '/', url: e.host ? `https://${e.host}${path}${path ? '/' : ''}` : null,
      live: vm?.status === 'running' && (e.status ?? 'active') === 'active' && ['valid', 'self-signed'].includes(e.cert?.status),
      note: vm?.status === 'stopped' ? 'Paused while stopped'
        : e.status === 'adding' || e.status === 'changing' ? 'Configuring…'
          : e.status === 'failed' ? 'Failed'
            : e.dns && e.dns.status !== 'verified' ? 'Waiting for DNS'
              : e.cert?.status === 'pending' ? 'Certificate pending' : e.cert?.status === 'self-signed' ? 'Self-signed' : null,
    };
  }

  const repoLabel = (url) => parseRepoUrl(url)?.fullName ?? String(url ?? '').replace(/^https:\/\//, '').replace(/\.git$/, '');

  function view(app, c) {
    const vm = c.vms.get(app.vm);
    const account = vm ? c.accounts.get(vm.account) : null;
    const op = c.active.get(app.name) ?? null;
    const status = statusOf(app, vm, op);
    const last = app.current ?? null;
    const connection = app.source?.gitConnection ? c.connections.get(app.source.gitConnection) : null;
    const problems = [];
    if (app.source?.gitConnection && !connection) problems.push(`Its Git connection ${app.source.gitConnection} was removed: give it another to redeploy.`);
    else if (connection && connection.state !== 'connected') problems.push(`${connection.id}: ${connection.problem}`);
    if (app.autoDeploy && app.webhook?.state !== 'active') problems.push(`Auto-deploy is not set up: ${app.webhook?.problem ?? 'no webhook.'}`);
    return {
      name: app.name,
      repo: repoLabel(app.source?.repo),
      repoUrl: app.source?.repo ?? null,
      branch: app.source?.branch ?? null,
      commit: short(last?.commit),
      autoDeploy: Boolean(app.autoDeploy),
      vm: app.vm,
      cloud: account?.cloud ?? null,
      cloudLabel: CLOUD[account?.cloud] ?? null,
      region: vm?.spec?.region ?? null,
      vmStatus: vm?.status ?? 'missing',
      endpoint: endpointOf(app, vm, c.endpoints),
      status: status.key,
      statusText: status.text,
      tone: status.tone,
      step: status.step ?? null,
      lastDeploy: last?.deployedAt ? { at: last.deployedAt, by: last.trigger === 'push' ? 'by push' : `by ${last.by?.name ?? 'someone'}`, trigger: last.trigger ?? null } : null,
      operation: op ? { id: op.id, type: op.type, status: op.status, progress: op.progress ?? 0, by: op.requestedBy?.name ?? null, at: op.createdAt ?? null, deploy: op.input?.deploy ?? null } : null,
      problem: problems.join(' ') || null,
      can: {
        redeploy: !op && vm?.status === 'running',
        viewLog: op?.type === 'app.deploy',
        startVm: !op && vm?.status === 'stopped',
        stop: !op && vm?.status === 'running' && ['live', 'crashed'].includes(app.status) && Boolean(last?.container),
        start: !op && vm?.status === 'running' && app.status === 'stopped' && Boolean(last?.container),
        delete: !op || op.type !== 'app.delete',
      },
    };
  }

  async function context() {
    const [vms, accounts, eps, connections, active] = await Promise.all([repos.vms.list(), repos.accounts.list(), repos.endpoints.list(), repos.gitConnections.list(), activeByApp()]);
    return {
      vms: new Map(vms.map((v) => [v.name, v])), accounts: new Map(accounts.map((a) => [a.id, a])), endpoints: eps,
      connections: new Map(connections.map((x) => [x.id, x])), active,
    };
  }

  /** An env row as the app page shows it: plain values, never secret ones. */
  const envView = (e) => (e.link?.database ? { key: e.key, kind: 'database', target: e.link.database }
    : e.link?.bucket ? { key: e.key, kind: 'bucket', target: e.link.bucket }
      : e.secretRef ? { key: e.key, kind: 'secret' } : { key: e.key, kind: 'plain', value: e.value });

  async function deploysOf(name, limit = 20) {
    return (await repos.apps.deploys(name).list())
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
      .map(({ body, ...d }) => ({ ...d, commit: short(d.commit), hasLog: Boolean(body) }));
  }

  // ---------------------------------------------------------------- checking what is asked

  async function validate(body, person) {
    const fields = {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isResourceName(name)) fields.name = 'Lower-case letters, numbers and dashes, starting with a letter.';
    else if (await repos.apps.get(name)) fields.name = `There is already an app called ${name}.`;

    const repo = parseRepoUrl(body.repo);
    if (!repo) fields.repo = 'An https:// URL such as https://github.com/stevie/storefront.git.';
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
    if (!isBranchName(branch)) fields.branch = 'A branch name such as main.';
    const dockerfile = body.dockerfile || './Dockerfile';
    if (!isRepoPath(dockerfile)) fields.dockerfile = 'A path inside the repository, such as ./Dockerfile.';
    const contextDir = body.context || '.';
    if (!isRepoPath(contextDir)) fields.context = 'A folder inside the repository, such as . or ./web.';
    const gitConnection = body.gitConnection || null;
    if (gitConnection) {
      const c = isResourceName(gitConnection) ? await repos.gitConnections.get(gitConnection) : null;
      if (!c) fields.gitConnection = 'Pick a Git connection, or none for a public repository.';
      else if (repo && c.provider !== repo.provider) fields.gitConnection = `${c.id} is for ${c.provider === 'github' ? 'GitHub' : 'GitLab'}; this repository is on ${repo.hostname}.`;
    }

    const vm = isResourceName(body.vm) ? await repos.vms.get(body.vm) : null;
    if (!vm || vm.role === 'database') fields.vm = 'Pick a VM.';
    else if (vm.status !== 'running') fields.vm = `${vm.name} is ${vm.status}. Start it, or pick a running VM.`;
    else if (vm.spec?.docker === false && !vm.runtime?.docker) fields.vm = `${vm.name} has no Docker. Pick a VM launched with Docker.`;

    const port = body.port === undefined || body.port === null || body.port === '' ? null : Number(body.port);
    if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) fields.port = 'The port the app listens on inside its container, from 1 to 65535.';
    const restart = body.restart ?? 'always';
    if (!RESTART_POLICIES[restart]) fields.restart = 'Always, on failure, or never.';

    const env = await checkEnv(body.env, { vm, fields });

    const ep = body.endpoint && body.endpoint.enabled !== false && body.endpoint.enabled !== 'false' ? body.endpoint : null;
    let endpoint = null;
    if (ep) {
      if (port === null) fields.port = 'An app on HTTPS needs the port it listens on.';
      const address = ep.address ?? 'domain';
      if (!['cloud', 'domain'].includes(address)) fields['endpoint.address'] = 'The cloud’s address or your own domain.';
      const domain = address === 'domain' ? String(ep.domain ?? '').trim().toLowerCase().replace(/\.$/, '') : null;
      const path = ep.path === undefined || ep.path === '' ? '/' : String(ep.path).trim().replace(/\/+$/, '') || '/';
      if (address === 'domain' && !isHostName(domain)) fields['endpoint.domain'] = 'A domain such as shop.example.com.';
      else if (address === 'domain' && !(await endpoints.isFree(domain, path))) fields['endpoint.domain'] = `${domain}${path === '/' ? '' : path} is already in use.`;
      if (!isEndpointPath(path)) fields['endpoint.path'] = 'A path such as / or /blog.';
      endpoint = { address, domain, path };
    }
    const healthCheck = body.healthCheck === undefined || body.healthCheck === null || body.healthCheck === '' ? (endpoint ? '/' : null) : String(body.healthCheck).trim();
    if (healthCheck !== null && !/^\/[A-Za-z0-9._~/?=&%-]{0,200}$/.test(healthCheck)) fields.healthCheck = 'A path such as /healthz.';
    if (healthCheck !== null && port === null) fields.port = 'A health check needs the port the app listens on.';

    const autoDeploy = body.autoDeploy === true || body.autoDeploy === 'true';
    if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields.', { fields });
    return {
      name, vm: vm.name,
      source: { repo: String(body.repo).trim(), branch, dockerfile, context: contextDir, gitConnection },
      run: { port, restart, env }, healthCheck, endpoint, autoDeploy, createdBy: who(person),
    };
  }

  /** Env rows: { key, value }, { key, value, secret: true }, { key, link: { database } } or { key, link: { bucket } }. */
  async function checkEnv(list, { vm, fields, existing = [] }) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_ENV) {
      fields.env = `Up to ${MAX_ENV} variables.`;
      return [];
    }
    const seen = new Set();
    const out = [];
    for (const [i, row] of list.entries()) {
      const key = typeof row?.key === 'string' ? row.key.trim() : '';
      if (!ENV_KEY.test(key)) { fields[`env.${i}.key`] = 'Capital letters, digits and underscores, such as DATABASE_URL.'; continue; }
      if (seen.has(key)) { fields[`env.${i}.key`] = `${key} is set twice.`; continue; }
      seen.add(key);
      if (row.link?.database !== undefined) {
        const db = isResourceName(row.link.database) ? await repos.databases.get(row.link.database) : null;
        if (!db) fields[`env.${i}.value`] = 'Pick a database.';
        else if (vm && db.account !== vm.account) fields[`env.${i}.value`] = `${db.name} is in ${db.account} and ${vm.name} in ${vm.account}: a database only takes connections from VMs in its own account.`;
        else out.push({ key, link: { database: db.name } });
      } else if (row.link?.bucket !== undefined) {
        const b = isBucketName(row.link.bucket) ? await repos.buckets.get(row.link.bucket) : null;
        if (!b) fields[`env.${i}.value`] = 'Pick a bucket.';
        else out.push({ key, link: { bucket: b.name } });
      } else if (row.value === undefined && existing.some((e) => e.key === key)) {
        out.push(existing.find((e) => e.key === key));
      } else if (typeof row.value !== 'string' || row.value.length > 32_768) {
        fields[`env.${i}.value`] = 'A value of up to 32 KB.';
      } else if (/[\r\n]/.test(row.value)) {
        fields[`env.${i}.value`] = 'One line: an environment file cannot hold line breaks.';
      } else if (row.secret === true || row.secret === 'true') {
        out.push({ key, secretRef: await secrets.put('app-env', row.value), _new: true });
      } else {
        out.push({ key, value: row.value });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the environment, at deploy time

  async function resolveEnv(ctx, app, vm) {
    const lines = [];
    for (const e of app.run?.env ?? []) {
      let value;
      let extra = [];
      if (e.link?.database) {
        const db = await repos.databases.get(e.link.database);
        if (!db) throw new CloudError('invalid', `${e.key} is linked to the database ${e.link.database}, which is gone.`);
        if (db.account !== vm.account) throw new CloudError('invalid', `${e.key}: ${db.name} is in ${db.account} and ${vm.name} in ${vm.account}. A database only takes connections from VMs in its own account.`);
        const password = db.adminPasswordRef ? await secrets.get(db.adminPasswordRef) : null;
        const hostName = db.observed?.host ?? null;
        if (!password || !hostName) throw new CloudError('invalid', `${e.key}: ${db.name} has no connection details yet.`);
        const user = encodeURIComponent(db.spec?.adminUser ?? 'admin');
        const dbName = encodeURIComponent(db.spec?.database ?? db.name);
        value = db.engine === 'mongodb'
          ? `mongodb://${user}:${encodeURIComponent(password)}@${hostName}:27017/${dbName}?authSource=admin`
          : `mysql://${user}:${encodeURIComponent(password)}@${hostName}:3306/${dbName}`;
        // Linking lets the app's VM connect (architecture.md §9); the database's firewall follows its allowVms.
        if (!(db.spec?.allowVms ?? []).includes(vm.name)) {
          await repos.databases.update(db.name, (r) => r && { ...r, spec: { ...r.spec, allowVms: [...(r.spec?.allowVms ?? []), vm.name] } });
          await ctx.log(`${vm.name} may now connect to ${db.name}`);
        }
        await ctx.log(`${e.key}: the connection string of ${db.name}`);
      } else if (e.link?.bucket) {
        const b = await repos.buckets.get(e.link.bucket);
        if (!b) throw new CloudError('invalid', `${e.key} is linked to the bucket ${e.link.bucket}, which is gone.`);
        value = b.name;
        const grant = (b.grants ?? []).find((g) => g.app === app.name);
        const keys = grant?.ref ? await secrets.get(grant.ref) : null;
        if (keys?.accessKey) {
          const account = ctx.account;
          const endpoint = account?.cloud === 'aws' ? `https://s3.${b.spec?.region ?? 'us-east-1'}.amazonaws.com` : 'https://storage.googleapis.com';
          extra = [`${e.key}_ACCESS_KEY=${keys.accessKey}`, `${e.key}_SECRET_KEY=${keys.secretKey}`, `${e.key}_ENDPOINT=${endpoint}`];
          await ctx.log(`${e.key}: ${b.name}, with its access keys (${grant.access ?? 'read and write'})`);
        } else {
          await ctx.log(`${e.key}: ${b.name} (no access keys: give ${app.name} access on the Buckets page)`);
        }
      } else if (e.secretRef) {
        value = await secrets.get(e.secretRef);
        if (value === null || value === undefined) throw new CloudError('invalid', `The secret value of ${e.key} is no longer stored. Set it again.`);
      } else {
        value = e.value ?? '';
      }
      if (/[\r\n]/.test(String(value))) throw new CloudError('invalid', `${e.key} has a line break, which an environment file cannot hold.`);
      lines.push(`${e.key}=${value}`, ...extra);
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  // ---------------------------------------------------------------- operations

  const appOf = async (ctx) => {
    const app = await repos.apps.get(ctx.input.app);
    if (!app) throw new CloudError('not_found', `The app ${ctx.input.app} is gone.`);
    return app;
  };
  const vmOf = async (ctx) => {
    const vm = await repos.vms.get(ctx.op.resource.name);
    if (!vm?.ref?.instance || vm.missing) throw new CloudError('not_found', `${ctx.op.resource.name} is no longer there.`);
    return vm;
  };
  async function onVm(ctx, vm, fn) {
    const runner = await remote.forVm(vm, ctx.account);
    try {
      return await fn(runner);
    } finally {
      runner.close();
    }
  }
  /** Runs one of our scripts on the VM; a non-zero exit is a CloudError with the script's own words. */
  async function script(ctx, vm, name, args, opts = {}) {
    return onVm(ctx, vm, async (runner) => {
      const result = await runner.run(name, args, { signal: ctx.signal, ...opts });
      const out = parse(result);
      if (result.code !== 0) throw new CloudError(result.code === 255 ? 'unavailable' : 'invalid', out?.message ?? (result.code === 255 ? `${vm.name} did not answer on SSH.` : `${name} failed on ${vm.name}.`));
      return out ?? {};
    });
  }
  const deployRepo = (ctx) => repos.apps.deploys(ctx.input.app);
  async function setDeploy(ctx, patch) {
    if (!isGeneratedId(ctx.input.deploy)) return null;
    return deployRepo(ctx).update(ctx.input.deploy, (d) => d && { ...d, ...patch });
  }
  const stepNo = (key) => DEPLOY_STEPS.findIndex(([k]) => k === key) + 1;
  const ROLLING_OUT = new Set(['start', 'health', 'switch', 'retire', 'prune']);
  const begin = (ctx, key) => setDeploy(ctx, { status: ROLLING_OUT.has(key) ? 'deploying' : 'building', step: stepNo(key) });

  const deploySteps = DEPLOY_STEPS.map(([key, label]) => ({ key, label, run: (ctx) => STEP[key](ctx) }));
  const STEP = {
    async source(ctx) {
      await begin(ctx, 'source');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      if (vm.status !== 'running') throw new CloudError('invalid', `${vm.name} is ${vm.status}. Start it, then deploy again.`);
      if (vm.spec?.docker === false && !vm.runtime?.docker) throw new CloudError('invalid', `${vm.name} has no Docker.`);
      try {
        await git.cloneToken(app.source.gitConnection);
      } catch (err) {
        if (err instanceof GitError) throw new CloudError('invalid', err.message);
        throw err;
      }
      const latest = ctx.input.commit ? { sha: ctx.input.commit, message: ctx.input.message ?? null } : await git.latest(app.source.repo, app.source.branch, app.source.gitConnection);
      await ctx.log(`${repoLabel(app.source.repo)} @ ${app.source.branch}${latest?.sha ? ` · ${short(latest.sha)}${latest.message ? ` ${latest.message}` : ''}` : ''} → ${vm.name}`);
      if (latest?.sha) await setDeploy(ctx, { commit: latest.sha, message: latest.message ?? null });
      await emit('infrastructure.app.building', { app: app.name, commit: short(latest?.sha) ?? app.source.branch, vm: vm.name, account: vm.account }, ctx.op.requestedBy?.id);
      return {};
    },
    async clone(ctx) {
      await begin(ctx, 'clone');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const token = await git.cloneToken(app.source.gitConnection);
      const tokenFile = token ? `git-token-${ctx.input.deploy.replace('_', '-')}` : '-';
      const out = await onVm(ctx, vm, async (runner) => {
        if (token) await runner.put(tokenFile, token, { mode: 0o600 });
        const result = await runner.run('app-clone', [app.name, parseRepoUrl(app.source.repo).cloneUrl, app.source.branch, ctx.input.deploy, tokenFile], { signal: ctx.signal });
        const parsed = parse(result);
        if (result.code !== 0) throw new CloudError('invalid', parsed?.message ?? `The clone failed on ${vm.name}.`);
        return parsed;
      });
      await ctx.log(`Cloned ${short(out.commit)}${out.message ? `: ${out.message}` : ''}${token ? ' (with the Git connection’s token, removed after)' : ''}`);
      await setDeploy(ctx, { commit: out.commit, message: out.message ?? null });
      return { state: { commit: out.commit, message: out.message ?? null } };
    },
    async build(ctx) {
      await begin(ctx, 'build');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const tag = `noobly-app/${app.name}:${String(ctx.state.commit).slice(0, 12)}`;
      let pending = [];
      let flushing = Promise.resolve();
      const flush = () => {
        if (!pending.length) return flushing;
        const text = pending.join('\n');
        pending = [];
        flushing = flushing.then(() => ctx.log(text));
        return flushing;
      };
      const timer = setInterval(flush, 500);
      try {
        await script(ctx, vm, 'app-build', [app.name, ctx.input.deploy, app.source.dockerfile, app.source.context, tag], {
          timeoutMs: 30 * 60_000,
          onLine: (line) => {
            if (line.startsWith('{')) return;
            pending.push(line.slice(0, 500));
            if (pending.length >= 50) flush();
          },
        });
      } finally {
        clearInterval(timer);
        await flush();
      }
      return { state: { image: tag } };
    },
    async env(ctx) {
      await begin(ctx, 'env');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const text = await resolveEnv(ctx, app, vm);
      const staged = `env-${ctx.input.deploy.replace('_', '-')}`;
      await onVm(ctx, vm, async (runner) => {
        await runner.put(staged, text, { mode: 0o600 });
        const result = await runner.run('app-env', [app.name, staged], { signal: ctx.signal });
        if (result.code !== 0) throw new CloudError('invalid', parse(result)?.message ?? 'The environment could not be written.');
      });
      const count = (app.run?.env ?? []).length;
      await ctx.log(`${count} variable${count === 1 ? '' : 's'} in /srv/apps/${app.name}/.env (0600)`);
      return {};
    },
    async start(ctx) {
      await begin(ctx, 'start');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const name = `${app.name}-${String(ctx.state.commit).slice(0, 7)}-${ctx.input.deploy.slice(-4)}`;
      const out = await script(ctx, vm, 'app-run', [app.name, ctx.state.image, name, app.run?.port ?? '-', RESTART_POLICIES[app.run?.restart ?? 'always']]);
      await ctx.log(`Started ${out.container}${out.port ? ` on 127.0.0.1:${out.port}` : ''} beside the version serving now`);
      await ctx.save({ container: out.container, hostPort: out.port ?? null });
      return { state: { container: out.container, hostPort: out.port ?? null } };
    },
    async health(ctx) {
      await begin(ctx, 'health');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const path = app.healthCheck ?? null;
      const usePort = path && ctx.state.hostPort ? ctx.state.hostPort : '-';
      const result = await onVm(ctx, vm, (runner) => runner.run('app-health', [ctx.state.container, usePort, usePort === '-' ? '-' : path, HEALTH_TIMEOUT_S], { signal: ctx.signal, timeoutMs: (HEALTH_TIMEOUT_S + 30) * 1000 }));
      const out = parse(result);
      if (result.code !== 0) {
        await onVm(ctx, vm, (runner) => runner.run('app-containers', ['remove', app.name, ctx.state.container], { signal: ctx.signal })).catch(() => {});
        await ctx.save({ container: null, removed: true });
        throw new CloudError('invalid', `The health check failed: ${out?.message ?? 'no answer'}.${app.current?.container ? ' The previous version keeps serving.' : ''}`);
      }
      await ctx.log(usePort === '-' ? 'The container keeps running' : `GET ${path} answered 200 after ${out?.seconds ?? 0} s`);
      return {};
    },
    async switch(ctx) {
      await begin(ctx, 'switch');
      const app = await appOf(ctx);
      // The app's endpoint: the one asked for on the Deploy page, or one added to it on the VM's page since.
      const existing = (await repos.endpoints.list()).some((e) => e.app === app.name && e.vm === app.vm);
      if (!app.endpoint && !existing) return { skipped: true, reason: 'no public endpoint' };
      if (!ctx.state.hostPort) return { skipped: true, reason: 'the app listens on no port' };
      const e = await endpoints.forApp(ctx, app, { upstreamPort: ctx.state.hostPort, spec: app.endpoint });
      await ctx.log(`https://${e.host}${e.path && e.path !== '/' ? e.path : ''} now goes to ${ctx.state.container}`);
      return { state: { switched: true } };
    },
    async retire(ctx) {
      await begin(ctx, 'retire');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const out = await script(ctx, vm, 'app-containers', ['retire', app.name, ctx.state.container]);
      if (!out.stopped?.length) return { skipped: true, reason: 'nothing was running before' };
      await ctx.log(`Stopped ${out.stopped.join(', ')}`);
      return {};
    },
    async prune(ctx) {
      await begin(ctx, 'prune');
      const app = await appOf(ctx);
      const vm = await vmOf(ctx);
      const out = await script(ctx, vm, 'app-containers', ['prune', app.name, KEEP_IMAGES]);
      if (!out.removed) return { skipped: true, reason: `no more than ${KEEP_IMAGES} images` };
      await ctx.log(`Removed ${out.removed} old image${out.removed === 1 ? '' : 's'}; the last ${KEEP_IMAGES} are kept`);
      return {};
    },
  };

  /** After a deploy that did not finish: the old version still serves (Live, or as it was), or there is none (Failed). */
  const afterFailure = (r) => {
    if (!r.current?.container) return 'failed';
    return r.status === 'building' ? 'live' : r.status;
  };

  /** The deploy's record gets the operation's log when it ends. */
  async function closeDeploy(ctx, patch) {
    const op = await repos.operations.get(ctx.op.id);
    await setDeploy(ctx, { ...patch, endedAt: iso(), body: op?.body ?? '' });
  }

  operations.define('app.deploy', {
    label: (op) => `Deploy ${op.input.app} to ${op.resource.name}`,
    verb: 'Deploying',
    steps: deploySteps,
    async succeeded(ctx) {
      const app = await repos.apps.update(ctx.input.app, (r) => r && {
        ...r, status: 'live', failure: null,
        current: {
          commit: ctx.state.commit, message: ctx.state.message ?? null, deployedAt: iso(), trigger: ctx.input.trigger ?? 'person', by: ctx.op.requestedBy ?? null,
          container: ctx.state.container, hostPort: ctx.state.hostPort ?? null, image: ctx.state.image, deploy: ctx.input.deploy,
        },
      });
      await closeDeploy(ctx, { status: 'live', step: DEPLOY_STEPS.length });
      if (app) await emit('infrastructure.app.deployed', { app: app.name, commit: short(ctx.state.commit), vm: app.vm, account: ctx.op.account }, ctx.op.requestedBy?.id);
    },
    async failed(ctx, err) {
      const reason = isCloudError(err) ? err.message : 'Something went wrong. It has been logged.';
      if (ctx.state?.container && !ctx.state.switched && !ctx.state.removed) {
        const vm = await repos.vms.get(ctx.op.resource.name);
        if (vm?.ref?.instance && ctx.account) await onVm(ctx, vm, (runner) => runner.run('app-containers', ['remove', ctx.input.app, ctx.state.container])).catch(() => {});
      }
      const app = await repos.apps.update(ctx.input.app, (r) => r && { ...r, status: afterFailure(r), failure: { reason, deploy: ctx.input.deploy, at: iso() } });
      await closeDeploy(ctx, { status: 'failed', reason });
      if (app) await emit('infrastructure.app.deploy_failed', { app: app.name, vm: app.vm, reason, commit: short(ctx.state?.commit) }, ctx.op.requestedBy?.id);
    },
    async cancelled(ctx) {
      await closeDeploy(ctx, { status: 'cancelled', reason: 'Cancelled.' });
      await repos.apps.update(ctx.input.app, (r) => r && { ...r, status: afterFailure(r) });
    },
  });

  const simple = (type, label, verb, steps, done) => operations.define(type, { label: (op) => `${label} ${op.input.app}`, verb, steps, succeeded: done });
  simple('app.stop', 'Stop', 'Stopping', [{
    key: 'stop', label: 'Stop the container',
    async run(ctx) {
      const app = await appOf(ctx);
      await script(ctx, await vmOf(ctx), 'app-containers', ['stop', app.name, app.current.container]);
      return {};
    },
  }], async (ctx) => {
    await repos.apps.update(ctx.input.app, (r) => r && { ...r, status: 'stopped' });
    await emit('infrastructure.app.stopped', { app: ctx.input.app, vm: ctx.op.resource.name }, ctx.op.requestedBy?.id);
  });
  simple('app.start', 'Start', 'Starting', [{
    key: 'start', label: 'Start the container',
    async run(ctx) {
      const app = await appOf(ctx);
      await script(ctx, await vmOf(ctx), 'app-containers', ['start', app.name, app.current.container]);
      return {};
    },
  }], async (ctx) => {
    await repos.apps.update(ctx.input.app, (r) => r && { ...r, status: 'live' });
  });
  simple('app.delete', 'Delete app', 'Deleting', [
    {
      key: 'endpoint', label: 'Remove its endpoint',
      async run(ctx) {
        const vm = await repos.vms.get(ctx.op.resource.name);
        if (!vm?.ref?.instance || vm.missing) return { skipped: true, reason: 'the VM is gone' };
        return (await endpoints.removeForApp(ctx, ctx.input.app)) ? {} : { skipped: true, reason: 'no endpoint' };
      },
    },
    {
      key: 'webhook', label: 'Remove the webhook',
      async run(ctx) {
        const app = await repos.apps.get(ctx.input.app);
        if (!app?.webhook?.id) return { skipped: true, reason: 'no webhook' };
        await git.removeHook(app);
        return {};
      },
    },
    {
      key: 'containers', label: 'Remove its containers and images',
      async run(ctx) {
        const vm = await repos.vms.get(ctx.op.resource.name);
        if (!vm?.ref?.instance || vm.missing) return { skipped: true, reason: 'the VM is gone' };
        await script(ctx, vm, 'app-containers', ['delete', ctx.input.app]);
        return {};
      },
    },
  ], async (ctx) => {
    const app = await repos.apps.get(ctx.input.app);
    if (!app) return;
    for (const e of app.run?.env ?? []) if (e.secretRef) await secrets.remove(e.secretRef);
    if (app.webhook?.secretRef) await secrets.remove(app.webhook.secretRef);
    const deploys = repos.apps.deploys(app.name);
    for (const d of await deploys.list()) await deploys.remove(d.id);
    await repos.apps.remove(app.name);
    await emit('infrastructure.app.deleted', { app: app.name, vm: app.vm }, ctx.op.requestedBy?.id);
  });

  // ---------------------------------------------------------------- starting work

  async function startDeploy(app, person, { trigger = 'person', commit = null, message = null, by = null } = {}) {
    const vm = await repos.vms.get(app.vm);
    if (!vm) throw conflict(`${app.vm} is no longer there.`);
    if (vm.status !== 'running') throw conflict(`${app.vm} is ${vm.status}. Start it to deploy.`);
    const active = (await activeByApp()).get(app.name);
    if (active?.type === 'app.delete') throw conflict(`${app.name} is being deleted.`);
    // A deploy still waiting to start takes the newest commit when it runs: no second one.
    if (active?.type === 'app.deploy' && active.status === 'queued') return { operation: { id: active.id, status: active.status }, deploy: active.input.deploy, queued: true };
    const deploy = { id: newId('dep'), app: app.name, trigger, by: by ?? who(person), commit, message, status: 'queued', step: 0, of: DEPLOY_STEPS.length, operation: null, startedAt: iso() };
    await repos.apps.deploys(app.name).write(deploy);
    const op = await operations.start('app.deploy', { resource: { type: 'vm', name: app.vm }, account: vm.account, input: { app: app.name, deploy: deploy.id, trigger, commit, message }, person: by ?? person });
    await repos.apps.deploys(app.name).update(deploy.id, (d) => d && { ...d, operation: op.id });
    return { operation: op, deploy: deploy.id };
  }

  async function addWebhook(app) {
    const base = publicUrl();
    if (!base) return { state: 'missing', problem: 'Set INFRA_PUBLIC_URL to the address the Git host reaches this server on.' };
    const secret = crypto.randomBytes(32).toString('hex');
    const secretRef = await secrets.put('webhook-secret', secret);
    try {
      const { id } = await git.addHook(app, { url: `${base}${mountPath}/hooks/git/${app.name}`, secret });
      return { state: 'active', id, secretRef, problem: null };
    } catch (err) {
      await secrets.remove(secretRef);
      if (err instanceof GitError || err.status === 422) return { state: 'missing', problem: err.message };
      throw err;
    }
  }

  const seen = new Set();

  return {
    DEPLOY_STEPS: DEPLOY_STEPS.map(([key, label]) => ({ key, label })),

    async list() {
      const c = await context();
      const apps = (await repos.apps.list()).sort((a, b) => a.name.localeCompare(b.name)).map((a) => view(a, c));
      return { apps, counts: { all: apps.length, live: apps.filter((a) => a.status === 'live').length, https: apps.filter((a) => a.status === 'live' && a.endpoint).length } };
    },

    async get(name) {
      const app = await mustGet(name);
      const c = await context();
      const vm = c.vms.get(app.vm);
      const e = c.endpoints.find((x) => x.app === app.name);
      return {
        ...view(app, c),
        source: { ...app.source },
        run: { port: app.run?.port ?? null, restart: app.run?.restart ?? 'always', env: (app.run?.env ?? []).map(envView) },
        healthCheck: app.healthCheck ?? null,
        endpointSpec: app.endpoint ?? (e ? { address: e.address, domain: e.address === 'domain' ? e.host : null, path: e.path } : null),
        current: app.current ? { ...app.current, commit: short(app.current.commit) } : null,
        failure: app.failure ?? null,
        webhook: app.autoDeploy ? { state: app.webhook?.state ?? 'missing', problem: app.webhook?.problem ?? null } : null,
        vmAccount: vm?.account ?? null,
        deploys: await deploysOf(app.name),
        createdAt: app.createdAt,
        createdBy: app.createdBy ?? null,
      };
    },

    /** What the Deploy page offers: the VMs apps can run on, the databases and buckets to link, the Git connections. */
    async formOptions() {
      const [vms, accounts, apps, databases, buckets, connections] = await Promise.all([
        repos.vms.list(), repos.accounts.list(), repos.apps.list(), repos.databases.list(), repos.buckets.list(), git.list(),
      ]);
      const cloudOf = new Map(accounts.map((a) => [a.id, a.cloud]));
      return {
        vms: vms.filter((v) => v.role !== 'database' && !v.missing).sort((a, b) => a.name.localeCompare(b.name)).map((v) => ({
          name: v.name, account: v.account, cloud: cloudOf.get(v.account) ?? null, region: v.spec?.region ?? null, status: v.status,
          docker: v.spec?.docker !== false || Boolean(v.runtime?.docker), apps: apps.filter((a) => a.vm === v.name).length,
        })),
        databases: databases.sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ name: d.name, engine: d.engine, account: d.account })),
        buckets: buckets.sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ name: b.name, account: b.account })),
        connections: connections.map((c) => ({ id: c.id, provider: c.provider, providerLabel: c.providerLabel, user: c.user, repoCount: c.repoCount, state: c.state, problem: c.problem, canHook: c.canHook })),
        steps: DEPLOY_STEPS.length,
      };
    },

    /** One deploy with its log (the operation's while it runs). */
    async deploy(name, id) {
      await mustGet(name);
      const d = isGeneratedId(id) ? await repos.apps.deploys(name).get(id) : null;
      if (!d) throw notFound(`No deploy ${id} of ${name}.`);
      const op = !d.body && d.operation ? await repos.operations.get(d.operation) : null;
      return { ...d, commit: short(d.commit), log: d.body || op?.body || '', body: undefined };
    },

    /** Deploys an app from Git (the Deploy page). → { app, operation, deploy } */
    async create(body, person) {
      await needs(host, person, 'draft', 'deploy an app');
      const spec = await validate(body ?? {}, person);
      const record = {
        name: spec.name, vm: spec.vm, status: 'building', source: spec.source,
        run: { ...spec.run, env: spec.run.env.map(({ _new, ...e }) => e) },
        healthCheck: spec.healthCheck, endpoint: spec.endpoint, autoDeploy: spec.autoDeploy, webhook: null,
        current: null, failure: null, createdAt: iso(), createdBy: spec.createdBy,
      };
      await repos.apps.write(record);
      if (record.autoDeploy) {
        const webhook = await addWebhook(record);
        await repos.apps.update(record.name, (r) => r && { ...r, webhook });
      }
      await emit('infrastructure.app.created', { app: record.name, vm: record.vm, repo: repoLabel(record.source.repo) }, person?.id);
      const started = await startDeploy(record, person);
      return { app: await this.get(record.name), operation: started.operation, deploy: started.deploy };
    },

    /** Redeploy: the branch's latest commit. */
    async redeploy(name, person) {
      await needs(host, person, 'draft', 'redeploy an app');
      const app = await mustGet(name);
      const started = await startDeploy(app, person);
      return { ...started, app: await this.get(name) };
    },

    async stop(name, person) {
      await needs(host, person, 'draft', 'stop an app');
      const app = await mustGet(name);
      const v = view(app, await context());
      if (!v.can.stop) throw conflict(`${name} is not running.`);
      const vm = await repos.vms.get(app.vm);
      return { operation: await operations.start('app.stop', { resource: { type: 'vm', name: app.vm }, account: vm.account, input: { app: name }, person }) };
    },

    async start(name, person) {
      await needs(host, person, 'draft', 'start an app');
      const app = await mustGet(name);
      const v = view(app, await context());
      if (!v.can.start) throw conflict(v.vmStatus !== 'running' ? `${app.vm} is ${v.vmStatus}. Start the VM first.` : `${name} is not stopped.`);
      const vm = await repos.vms.get(app.vm);
      return { operation: await operations.start('app.start', { resource: { type: 'vm', name: app.vm }, account: vm.account, input: { app: name }, person }) };
    },

    async remove(name, body, person) {
      await needs(host, person, 'approve', 'delete an app');
      await peopleOnly(host, person, 'delete an app');
      const app = await mustGet(name);
      if (body?.confirm !== name) throw unprocessable(`Type ${name} to delete it.`, { fields: { confirm: `Type ${name}.` } });
      const vm = await repos.vms.get(app.vm);
      if (vm && !vm.missing && vm.status !== 'running') throw conflict(`${app.vm} is ${vm.status}. Start it first, so the app’s containers can be removed.`);
      const active = (await activeByApp()).get(name);
      if (active) throw conflict(`${name} is busy: wait for “${active.type === 'app.deploy' ? 'the deploy' : active.type.slice(4)}” to finish, or cancel it.`);
      return { operation: await operations.start('app.delete', { resource: { type: 'vm', name: app.vm }, account: vm?.account ?? null, input: { app: name }, person }) };
    },

    /** The last lines of the running container's output. */
    async logs(name, { lines = 200 } = {}) {
      const app = await mustGet(name);
      if (!app.current?.container) return { lines: [], note: 'Nothing has been deployed yet.' };
      const vm = await repos.vms.get(app.vm);
      if (vm?.status !== 'running') return { lines: [], note: `${app.vm} is ${vm?.status ?? 'gone'}.` };
      const account = await repos.accounts.get(vm.account);
      const runner = await remote.forVm(vm, account);
      try {
        const result = await runner.run('app-containers', ['logs', app.name, app.current.container, Math.min(2000, Math.max(1, Number(lines) || 200))]);
        if (result.code !== 0) throw new HttpError(502, 'unavailable', parse(result)?.message ?? `${app.vm} did not send the logs.`);
        return { lines: secrets.scrub(result.stdout).split('\n').filter(Boolean), container: app.current.container };
      } finally {
        runner.close();
      }
    },

    /**
     * POST /hooks/git/:app (architecture.md §9 "Auto-deploy"): GitHub's HMAC signature or GitLab's token must match the
     * app's webhook secret; a push to the app's branch deploys that commit. → { status, body }
     */
    async push(name, { headers, raw }) {
      const refuse = { status: 401, body: { error: { code: 'signature', message: 'The signature does not match.' } } };
      const app = isResourceName(name) ? await repos.apps.get(name) : null;
      const secret = app?.autoDeploy && app.webhook?.secretRef ? await secrets.get(app.webhook.secretRef) : null;
      if (!secret) return refuse;
      const h = (k) => headers[k.toLowerCase()] ?? '';
      const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
      const gitlab = Boolean(h('x-gitlab-event'));
      const signed = gitlab ? equal(String(h('x-gitlab-token')), secret)
        : equal(String(h('x-hub-signature-256')), `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
      if (!signed) return refuse;
      const event = gitlab ? h('x-gitlab-event') : h('x-github-event');
      if (event === 'ping') return { status: 200, body: { ok: true } };
      if (event !== 'push' && event !== 'Push Hook') return { status: 202, body: { ignored: `${event} events start nothing.` } };
      const delivery = `${name}:${gitlab ? h('x-gitlab-event-uuid') : h('x-github-delivery')}`;
      if (delivery.length > name.length + 1 && seen.has(delivery)) return { status: 200, body: { duplicate: true } };
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return { status: 400, body: { error: { code: 'invalid', message: 'Send the event as JSON.' } } };
      }
      seen.add(delivery);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      const ref = String(payload.ref ?? '');
      const after = String(payload.after ?? '');
      if (ref !== `refs/heads/${app.source.branch}`) return { status: 202, body: { ignored: `Only a push to ${app.source.branch} deploys ${app.name}.` } };
      if (payload.deleted || /^0+$/.test(after)) return { status: 202, body: { ignored: 'The branch was deleted.' } };
      const message = String((gitlab ? payload.commits?.at(-1)?.message : payload.head_commit?.message) ?? '').split('\n')[0].slice(0, 200) || null;
      const pusher = String((gitlab ? payload.user_username : payload.pusher?.name ?? payload.sender?.login) ?? 'git').slice(0, 100);
      try {
        const started = await startDeploy(app, null, { trigger: 'push', commit: /^[0-9a-f]{40}$/.test(after) ? after : null, message, by: { id: `git:${pusher}`, name: pusher } });
        return { status: 202, body: { deploying: true, queued: Boolean(started.queued) } };
      } catch (err) {
        if (err instanceof HttpError) return { status: 409, body: { error: { code: 'conflict', message: err.message } } };
        throw err;
      }
    },

    /** Every live app's container, read from its VM: a container that stopped is Crashed; one running again is Live. */
    async checkContainers() {
      const apps = (await repos.apps.list()).filter((a) => ['live', 'crashed'].includes(a.status) && a.current?.container);
      const active = await activeByApp();
      const byVm = new Map();
      for (const a of apps) if (!active.has(a.name)) byVm.set(a.vm, [...(byVm.get(a.vm) ?? []), a]);
      for (const [vmName, list] of byVm) {
        const vm = await repos.vms.get(vmName);
        if (vm?.status !== 'running' || !vm.ref?.instance) continue;
        const account = await repos.accounts.get(vm.account);
        let runner;
        try {
          runner = await remote.forVm(vm, account);
          for (const a of list) {
            const out = parse(await runner.run('app-containers', ['state', a.name]));
            const c = out?.containers?.find((x) => x.name === a.current.container);
            const crashed = !c || c.state !== 'running';
            if (crashed && a.status === 'live') {
              await repos.apps.update(a.name, (r) => r && { ...r, status: 'crashed', failure: { reason: c ? `The container exited with code ${c.exitCode} (restarted ${c.restarts} times).` : 'The container is gone.', at: iso() } });
              await emit('infrastructure.app.crashed', { app: a.name, vm: vmName, reason: c ? `exit code ${c.exitCode}` : 'the container is gone' });
            } else if (!crashed && a.status === 'crashed') {
              await repos.apps.update(a.name, (r) => r && { ...r, status: 'live', failure: null });
            }
          }
        } catch (err) {
          log.warn(`app containers on ${vmName}: ${err.message}`);
        } finally {
          runner?.close();
        }
      }
    },

    /** The seed story's apps: webhook secrets, database passwords and bucket keys (secrets can't be seed files). */
    async seedSecrets() {
      for (const db of await repos.databases.list()) {
        if (db.adminPasswordRef) continue;
        const ref = await secrets.put('db-password', crypto.randomBytes(24).toString('base64url'));
        await repos.databases.update(db.name, (r) => r && { ...r, adminPasswordRef: ref });
      }
      for (const app of await repos.apps.list()) {
        for (const e of app.run?.env ?? []) {
          if (!e.link?.bucket) continue;
          const b = await repos.buckets.get(e.link.bucket);
          if (!b || (b.grants ?? []).some((g) => g.app === app.name)) continue;
          const ref = await secrets.put('bucket-grant', { accessKey: `MOCK${crypto.randomBytes(8).toString('hex').toUpperCase()}`, secretKey: crypto.randomBytes(20).toString('base64url') });
          await repos.buckets.update(b.name, (r) => r && { ...r, grants: [...(r.grants ?? []), { app: app.name, access: 'read and write', ref }] });
        }
        if (app.autoDeploy && !app.webhook?.secretRef) {
          const ref = await secrets.put('webhook-secret', crypto.randomBytes(32).toString('hex'));
          await repos.apps.update(app.name, (r) => r && { ...r, webhook: { state: 'active', id: null, secretRef: ref, problem: null } });
        }
      }
    },
  };
}
