// Checking a workload's spec (spec 8.1). A launcher's input becomes a record with every default filled in, or an
// `invalid` error whose details name each field that is wrong ({ fields: { 'run.port': 'Between 1 and 65535.' } }), so
// a form can say it next to the field.
import { unprocessable } from '../util/errors.js';
import { isResourceName } from '../util/ids.js';
import { isWorkloadName, KINDS, RUNTIMES, HTTP_KINDS } from './names.js';
import { isPublishDir } from '../../agent/protocol.js';

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LINKS = ['database', 'keyvalue', 'bucket'];

/** What update() may change; name, kind, region and account are fixed once a workload exists. */
export const CHANGEABLE = ['source', 'build', 'run', 'plan', 'instances', 'healthCheck', 'domains', 'autoDeploy', 'schedule', 'concurrency', 'sleep', 'site'];
/** Changes that need a new build and rollout; plan and instances need only a rolling restart (scale). */
export const REDEPLOY = ['source', 'build', 'run'];
export const RESCALE = ['plan', 'instances'];

export const LIMITS = { instances: 20, cpu: 16, memoryMb: 65536, env: 200, domains: 20, concurrency: 20 };
/** A key for a variable of the workload or of one run (runJob's env). */
export const isEnvKey = (k) => typeof k === 'string' && ENV_KEY.test(k);
/** A public Git repository's https:// URL: a host and a path, no credentials, query or fragment. */
export function isPublicGitUrl(v) {
  // URL() resolves '..' and percent-escapes away, so look at the text as written first.
  if (typeof v !== 'string' || v.length > 500 || !v.startsWith('https://') || v.includes('%') || v.slice(8).split('/').includes('..')) return false;
  try {
    const u = new URL(v);
    return Boolean(u.hostname) && !u.username && !u.password && !u.search && !u.hash && /^\/[A-Za-z0-9._~/-]+$/.test(u.pathname) && u.pathname.length > 1 && !u.pathname.split('/').includes('..');
  } catch {
    return false;
  }
}

export const DEFAULT_PLAN = { cpu: 0.5, memoryMb: 512 };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;

/**
 * @param {object} input   the launcher's spec
 * @param {{ regions: Set<string> }} o   the catalogue's region ids
 * @returns {object} the record's spec fields
 */
export function checkSpec(input, { regions }) {
  const fields = {};
  const bad = (field, message) => {
    fields[field] ??= message;
  };
  if (!isObject(input)) throw unprocessable('A workload spec is an object.', { fields: { spec: 'Send an object.' } });

  if (!isWorkloadName(input.name)) bad('name', 'Lower-case letters, digits and hyphens; starts with a letter; up to 63 characters.');
  const kind = input.kind ?? 'service';
  if (!KINDS.includes(kind)) bad('kind', `One of ${KINDS.join(', ')}.`);
  const http = HTTP_KINDS.has(kind);

  const region = input.region ?? 'af-south-1';
  if (typeof region !== 'string' || !regions.has(region)) bad('region', 'A region from the catalogue, such as af-south-1 or africa-south1.');
  const account = input.account ?? null;
  if (account !== null && !isResourceName(account)) bad('account', 'The name of a connected cloud account.');

  // Source: a repository, or a prebuilt image.
  const src = input.source ?? {};
  let source = null;
  if (!isObject(src)) bad('source', 'Send { repo, branch } or { image }.');
  else if (src.repo !== undefined && src.image !== undefined) bad('source', 'Either a repository or an image, not both.');
  else if (src.image !== undefined) {
    if (!text(src.image, 255) || !IMAGE.test(src.image)) bad('source.image', 'An image reference, such as ghcr.io/acme/api:1.4.');
    source = { image: src.image };
  } else {
    if (!text(src.repo, 500) || !(REPO.test(src.repo) || isPublicGitUrl(src.repo))) bad('source.repo', 'owner/name of a GitHub repository, or a public https:// Git URL.');
    const branch = src.branch ?? 'main';
    if (!text(branch, 200) || !BRANCH.test(branch)) bad('source.branch', 'A branch name.');
    const rootDir = src.rootDir ?? '';
    if (!text(rootDir, 200) || rootDir.includes('..') || rootDir.startsWith('/')) bad('source.rootDir', 'A folder inside the repository.');
    const gitConnection = src.gitConnection ?? null;
    if (gitConnection !== null && !text(gitConnection, 200)) bad('source.gitConnection', 'The launcher\'s Git connection id.');
    source = { repo: src.repo, branch, rootDir, gitConnection };
  }

  // Build: only for a repository.
  const b = input.build ?? {};
  let build = null;
  if (!isObject(b)) bad('build', 'Send { runtime, buildCommand, startCommand }.');
  else if (source?.repo) {
    const runtime = b.runtime ?? 'node22';
    if (!RUNTIMES.includes(runtime)) bad('build.runtime', `One of ${RUNTIMES.join(', ')}.`);
    for (const key of ['buildCommand', 'startCommand', 'dockerfile']) if (b[key] !== undefined && b[key] !== null && (!text(b[key], 500) || /[\r\n]/.test(b[key]))) bad(`build.${key}`, 'One line of up to 500 characters.');
    build = { runtime, buildCommand: b.buildCommand ?? null, startCommand: b.startCommand ?? null, dockerfile: runtime === 'dockerfile' ? (b.dockerfile ?? 'Dockerfile') : null };
    // A static site's output folder (spec 8.8 R1), in the build's working directory; '.' publishes all of it.
    if (kind === 'static') {
      const publishDir = b.publishDir ?? 'dist';
      if (!isPublishDir(publishDir)) bad('build.publishDir', 'A folder inside the build, such as dist or build/out, or . for all of it.');
      build.publishDir = publishDir;
    } else if (b.publishDir !== undefined && b.publishDir !== null) bad('build.publishDir', 'Only a static site publishes a folder.');
  }

  // Run: a port for the HTTP kinds, a command, the environment.
  const r = input.run ?? {};
  let run = null;
  if (!isObject(r)) bad('run', 'Send { port, command, env }.');
  else {
    let port = null;
    if (http) {
      port = r.port ?? 10000;
      if (!Number.isInteger(port) || port < 1 || port > 65535) bad('run.port', 'A port between 1 and 65535.');
    } else if (r.port !== undefined && r.port !== null) bad('run.port', `A ${kind} listens on no port.`);
    if (r.command !== undefined && r.command !== null && !text(r.command, 500)) bad('run.command', 'Up to 500 characters.');
    const env = r.env ?? [];
    if (!Array.isArray(env) || env.length > LIMITS.env) bad('run.env', `A list of up to ${LIMITS.env} variables.`);
    else {
      const seen = new Set();
      env.forEach((e, i) => {
        const at = `run.env.${i}`;
        if (!isObject(e) || !text(e.key, 128) || !ENV_KEY.test(e.key)) return bad(at, 'A key of letters, digits and underscores.');
        if (seen.has(e.key)) return bad(at, `${e.key} is set twice.`);
        seen.add(e.key);
        const given = ['value', 'secretRef', 'link'].filter((k) => e[k] !== undefined);
        if (given.length !== 1) return bad(at, 'Exactly one of value, secretRef or link.');
        if (e.value !== undefined && !text(e.value, 32_768)) return bad(at, 'A value is text, up to 32 KB.');
        if (e.secretRef !== undefined && !text(e.secretRef, 200)) return bad(at, 'The launcher\'s secret reference.');
        if (e.build !== undefined && typeof e.build !== 'boolean') return bad(at, 'build is true (also available while building, spec 8.3 R5) or false.');
        if (e.build && e.link !== undefined) return bad(at, 'A linked value is not available while building.');
        if (e.link !== undefined && !(isObject(e.link) && Object.keys(e.link).length === 1 && LINKS.includes(Object.keys(e.link)[0]) && text(Object.values(e.link)[0], 100))) {
          return bad(at, `A link names one ${LINKS.join(', ')}.`);
        }
        return null;
      });
    }
    run = { port, command: r.command ?? null, env: Array.isArray(env) ? env.map((e) => ({ ...e })) : [] };
  }

  const plan = input.plan ?? DEFAULT_PLAN;
  if (!isObject(plan) || typeof plan.cpu !== 'number' || !(plan.cpu > 0) || plan.cpu > LIMITS.cpu) bad('plan.cpu', `Between 0.1 and ${LIMITS.cpu} vCPU.`);
  if (!isObject(plan) || !Number.isInteger(plan.memoryMb) || plan.memoryMb < 128 || plan.memoryMb > LIMITS.memoryMb) bad('plan.memoryMb', `Between 128 and ${LIMITS.memoryMb} MB.`);

  const fixedOne = kind === 'static' || kind === 'job';
  const instances = input.instances ?? 1;
  if (!Number.isInteger(instances) || instances < 1 || instances > LIMITS.instances) bad('instances', `Between 1 and ${LIMITS.instances}.`);
  else if (fixedOne && instances !== 1) bad('instances', `A ${kind} runs one at a time.`);

  let healthCheck = null;
  if (http) {
    const h = input.healthCheck ?? {};
    const path = h.path ?? '/';
    const timeoutS = h.timeoutS ?? 60;
    if (!isObject(h) || !text(path, 200) || !path.startsWith('/')) bad('healthCheck.path', 'A path starting with /.');
    if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 600) bad('healthCheck.timeoutS', 'Between 1 and 600 seconds.');
    healthCheck = { path, timeoutS };
  } else if (input.healthCheck !== undefined && input.healthCheck !== null) bad('healthCheck', `A ${kind} has no HTTP health check.`);

  const domains = input.domains ?? [];
  if (!Array.isArray(domains) || domains.length > LIMITS.domains) bad('domains', `Up to ${LIMITS.domains} host names.`);
  else {
    if (domains.length && !(http || kind === 'static') ) bad('domains', `A ${kind} serves no domains.`);
    domains.forEach((d, i) => {
      if (!text(d, 253) || !HOSTNAME.test(d)) bad(`domains.${i}`, 'A host name such as api.example.com.');
    });
    if (new Set(domains).size !== domains.length) bad('domains', 'A domain is listed twice.');
  }

  const a = input.autoDeploy ?? null;
  let autoDeploy = null;
  if (a !== null) {
    if (!isObject(a) || !source?.repo) bad('autoDeploy', 'Auto-deploy needs a repository: { branch, webhookSecretRef }.');
    else {
      const branch = a.branch ?? source.branch;
      if (!text(branch, 200) || !BRANCH.test(branch)) bad('autoDeploy.branch', 'A branch name.');
      if (a.webhookSecretRef !== undefined && a.webhookSecretRef !== null && !text(a.webhookSecretRef, 200)) bad('autoDeploy.webhookSecretRef', 'The launcher\'s secret reference.');
      autoDeploy = { branch, webhookSecretRef: a.webhookSecretRef ?? null };
    }
  }

  // Idle sleep (spec 8.4.8): a web service with no request through its region's ingress for afterMin minutes stops its
  // instances; the next request wakes it. Other kinds never sleep (nothing in front of them holds a request).
  const sl = input.sleep ?? null;
  let sleep = null;
  if (sl !== null) {
    if (kind !== 'service') bad('sleep', 'Only a web service sleeps: it has an ingress in front of it to hold the next request.');
    else if (!isObject(sl) || !Number.isInteger(sl.afterMin) || sl.afterMin < 5 || sl.afterMin > 1440) bad('sleep.afterMin', 'From 5 to 1440 minutes.');
    else sleep = { afterMin: sl.afterMin };
  }

  // A job's schedule is kept by the launcher (spec 8.1, R3); it is stored so the Platform screen can show it.
  const schedule = input.schedule ?? null;
  if (schedule !== null && (kind !== 'job' || !text(schedule, 100))) bad('schedule', kind === 'job' ? 'Up to 100 characters.' : 'Only a job has a schedule.');
  // How many of a job's runs may go at once (8.2 R6): 1 for a schedule's job; more for a launcher's task queue.
  const concurrency = input.concurrency ?? (kind === 'job' ? 1 : null);
  if (kind !== 'job' && concurrency !== null) bad('concurrency', 'Only a job has runs.');
  else if (kind === 'job' && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > LIMITS.concurrency)) bad('concurrency', `From 1 to ${LIMITS.concurrency} runs at once.`);

  // How a static site answers (spec 8.8 R5): spa sends paths with no file and no extension to /index.html.
  const st = input.site ?? null;
  let site = null;
  if (kind === 'static') {
    const v = st ?? {};
    if (!isObject(v) || (v.spa !== undefined && typeof v.spa !== 'boolean')) bad('site.spa', 'true (a single-page app) or false.');
    else site = { spa: v.spa ?? false };
  } else if (st !== null) bad('site', 'Only a static site has site settings.');

  if (Object.keys(fields).length) {
    throw unprocessable(`Check ${Object.keys(fields).join(', ')}.`, { fields });
  }
  return {
    name: input.name, kind, region, account, source, build, run, plan: { cpu: plan.cpu, memoryMb: plan.memoryMb }, instances,
    healthCheck, domains: [...domains], autoDeploy, sleep, ...(kind === 'job' ? { schedule, concurrency } : {}), ...(kind === 'static' ? { site } : {}),
  };
}

/** The spec fields of a record (what checkSpec returns), to check a change against. */
export const specOf = (record) => Object.fromEntries(['name', 'kind', 'region', 'account', ...CHANGEABLE].map((k) => [k, record[k]]).filter(([, v]) => v !== undefined));

/** Whether two values are the same, field by field (records are plain JSON). */
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
