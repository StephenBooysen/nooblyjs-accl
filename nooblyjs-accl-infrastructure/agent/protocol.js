// The agent protocol, version 1 (spec 8.9 R3, R5, "Protocol"). One WebSocket between a local server's agent and the
// controller carries JSON frames `{ v: 1, id?, type, ... }`. Both sides import this file, so both check the same rules:
// a frame the controller would refuse to send, the agent refuses to run.
//
// There is deliberately no command that runs a shell command or `docker exec` (R5). Every value that reaches Docker is
// checked here first: names, labels, images, paths, limits and environment keys.

export const PROTOCOL_VERSION = 1;
export const AGENT_VERSION = '0.1.0';
/** R12: frames over 1 MB are refused. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** R3: heartbeat every 15 s; a server silent for 45 s is offline. */
export const HEARTBEAT_MS = 15_000;
export const OFFLINE_AFTER_MS = 45_000;
/** R6: host ports for instances. */
export const HOST_PORTS = { min: 20000, max: 29999 };
/** R11 (8.5 R3): log lines over 16 KB are cut and marked. */
export const MAX_LOG_LINE = 16 * 1024;
/** Spec 8.8: a site's files come back in chunks of up to 512 KB (base64 in a frame, under MAX_FRAME_BYTES). */
export const CHUNK_BYTES = 512 * 1024;
/** Spec 8.8: the most a site export may send. */
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export const CUT_MARK = ' …[cut]';

export class ProtocolError extends Error {
  /** @param {string} code  'too_large' | 'bad_json' | 'bad_version' | 'bad_frame' | 'unknown_type' | 'invalid' */
  constructor(code, message, problems = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

// ---- value rules --------------------------------------------------------------------------------

export const RULES = {
  workload: /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/,
  container: /^noobly-[a-z0-9][a-z0-9-]{0,100}$/,
  network: /^noobly-t-[a-f0-9]{8,32}$/,
  image: /^noobly\/[a-f0-9]{8,32}\/[a-z]([-a-z0-9]{0,61}[a-z0-9])?:[0-9a-f]{7,40}$/,
  labelKey: /^[a-z0-9][a-z0-9.-]{0,62}$/,
  envKey: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
  commit: /^[0-9a-f]{7,40}$/,
  stream: /^[a-z0-9][a-z0-9-]{0,63}$/,
  /** A tenant's private name for a workload (spec 8.2 R5): <workload>.<tenant>.internal. */
  alias: /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.internal$/,
  /** Ingress (spec 8.4): a site id, a host name it answers on, an upstream (a host's private address and port). */
  site: /^[a-z0-9][a-z0-9-]{0,99}$/,
  host: /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  upstream: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}:(2\d{4})$/,
  hookUrl: /^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~\/-]*)?$/,
  /** A registry host (spec 8.3): africa-south1-docker.pkg.dev, 123456789012.dkr.ecr.af-south-1.amazonaws.com. */
  registry: /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/,
  /** An image reference to push to or pull from: [host/]path[:tag][@sha256:digest]. Never starts with a dash. */
  ref: /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?\/)?[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/,
  ipv4: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
};
export const RUNTIMES = ['node22', 'python312', 'go123', 'dockerfile'];

/** A Git branch name that `git check-ref-format --branch` would accept, kept simple and never starting with '-'. */
export function isBranch(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith('-') && !v.startsWith('/')
    && !v.endsWith('/') && !v.endsWith('.lock') && !v.includes('..') && !v.includes('//') && !v.includes('@{');
}

/** A folder inside the repository: relative, no '..', no leading '-'. Empty means the top. */
export function isRootDir(v) {
  if (v === '' || v === undefined || v === null) return true;
  return typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith('/') && !v.startsWith('-')
    && !v.split('/').includes('..');
}

/** A static site's publish directory (spec 8.8 R1): a folder inside the image's working directory, or '.' for all of it. */
export function isPublishDir(v) {
  return v === '.' || (typeof v === 'string' && v.length >= 1 && isRootDir(v) && !v.endsWith('/'));
}

/** https://host/path (no credentials in the URL), or file:///abs/path. file:// is only run by an agent in --dev mode. */
export function isRepoUrl(v) {
  if (typeof v !== 'string' || v.length > 500 || v.startsWith('-')) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return Boolean(u.hostname) && !u.username && !u.password && u.pathname.length > 1;
  // URL() resolves '..' away, so look at the text as written: no '..' segment, no percent-encoding tricks.
  if (u.protocol === 'file:') return !u.hostname && u.pathname.length > 1 && !v.includes('%') && !v.slice('file://'.length).split('/').includes('..');
  return false;
}

// ---- a tiny schema checker ------------------------------------------------------------------------

const S = {
  str: (re, { optional = false, max = 500 } = {}) => ({ kind: 'str', re, optional, max }),
  text: (max, { optional = false } = {}) => ({ kind: 'str', re: null, optional, max }),
  int: (min, max, { optional = false } = {}) => ({ kind: 'int', min, max, optional }),
  num: (min, max, { optional = false } = {}) => ({ kind: 'num', min, max, optional }),
  bool: ({ optional = true } = {}) => ({ kind: 'bool', optional }),
  fn: (test, message, { optional = false } = {}) => ({ kind: 'fn', test, message, optional }),
  labels: ({ optional = false, requireInstall = true } = {}) => ({ kind: 'labels', optional, requireInstall }),
  env: () => ({ kind: 'env', optional: true }),
  strings: (maxItems, maxLen, { optional = true } = {}) => ({ kind: 'strings', maxItems, maxLen, optional }),
  obj: (shape, { optional = false } = {}) => ({ kind: 'obj', shape, optional }),
  /** A list whose every item meets `item`. */
  list: (item, maxItems, { optional = false } = {}) => ({ kind: 'list', item, maxItems, optional }),
};

function check(value, rule, path, problems) {
  if (value === undefined || value === null) {
    if (!rule.optional) problems.push({ path, message: 'Required.' });
    return;
  }
  switch (rule.kind) {
    case 'str':
      if (typeof value !== 'string') return problems.push({ path, message: 'A string.' });
      if (value.length > rule.max) return problems.push({ path, message: `Up to ${rule.max} characters.` });
      if (rule.re && !rule.re.test(value)) problems.push({ path, message: 'Not in the allowed form.' });
      return;
    case 'int':
      if (!Number.isInteger(value) || value < rule.min || value > rule.max) problems.push({ path, message: `A whole number from ${rule.min} to ${rule.max}.` });
      return;
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) problems.push({ path, message: `A number from ${rule.min} to ${rule.max}.` });
      return;
    case 'bool':
      if (typeof value !== 'boolean') problems.push({ path, message: 'true or false.' });
      return;
    case 'fn':
      if (!rule.test(value)) problems.push({ path, message: rule.message });
      return;
    case 'labels': {
      if (typeof value !== 'object' || Array.isArray(value)) return problems.push({ path, message: 'An object of labels.' });
      const entries = Object.entries(value);
      if (entries.length > 20) return problems.push({ path, message: 'Up to 20 labels.' });
      for (const [k, v] of entries) {
        if (!RULES.labelKey.test(k)) problems.push({ path: `${path}.${k}`, message: 'A label key of lower-case letters, digits, dots and hyphens.' });
        if (typeof v !== 'string' || v.length > 200 || /[\r\n]/.test(v)) problems.push({ path: `${path}.${k}`, message: 'A one-line string of up to 200 characters.' });
      }
      if (rule.requireInstall && typeof value['noobly-install'] !== 'string') problems.push({ path: `${path}.noobly-install`, message: 'Every command names its install.' });
      return;
    }
    case 'env': {
      if (!Array.isArray(value) || value.length > 100) return problems.push({ path, message: 'Up to 100 variables.' });
      const seen = new Set();
      value.forEach((e, i) => {
        if (!RULES.envKey.test(e?.key ?? '')) problems.push({ path: `${path}.${i}.key`, message: 'Letters, digits and underscores; not starting with a digit.' });
        else if (seen.has(e.key)) problems.push({ path: `${path}.${i}.key`, message: 'Set twice.' });
        else seen.add(e.key);
        if (typeof e?.value !== 'string' || e.value.length > 32_768) problems.push({ path: `${path}.${i}.value`, message: 'A string of up to 32 KB.' });
      });
      return;
    }
    case 'strings':
      if (!Array.isArray(value) || value.length > rule.maxItems || value.some((s) => typeof s !== 'string' || s.length > rule.maxLen)) {
        problems.push({ path, message: `Up to ${rule.maxItems} strings of up to ${rule.maxLen} characters.` });
      }
      return;
    case 'list':
      if (!Array.isArray(value) || value.length > rule.maxItems) return problems.push({ path, message: `A list of up to ${rule.maxItems}.` });
      value.forEach((v, i) => check(v, rule.item, `${path}.${i}`, problems));
      return;
    case 'obj':
      if (typeof value !== 'object' || Array.isArray(value)) return problems.push({ path, message: 'An object.' });
      for (const key of Object.keys(value)) if (!(key in rule.shape)) problems.push({ path: `${path}.${key}`, message: 'Not allowed.' });
      for (const [key, r] of Object.entries(rule.shape)) check(value[key], r, `${path}.${key}`, problems);
      return;
    default:
      problems.push({ path, message: 'Unknown rule.' });
  }
}

// ---- the commands (R5) ------------------------------------------------------------------------------

const container = S.str(RULES.container, { max: 108 });
const runShape = {
  name: container,
  image: S.str(RULES.image, { max: 200 }),
  labels: S.labels(),
  network: S.str(RULES.network, { optional: true }),
  aliases: S.strings(4, 140),
  cpu: S.num(0.05, 64),
  memoryMb: S.int(64, 262_144),
  pidsLimit: S.int(16, 4096, { optional: true }),
  port: S.int(1, 65_535, { optional: true }),
  hostPort: S.int(HOST_PORTS.min, HOST_PORTS.max, { optional: true }),
  bind: S.str(RULES.ipv4, { optional: true, max: 15 }),
  env: S.env(),
  command: S.strings(50, 4096),
  readOnly: S.bool(),
};

/** Short-lived registry credentials (spec 8.3 R3): push on builders, read-only on hosts. Masked; never written to disk for long. */
const registryAuth = S.obj({
  server: S.str(RULES.registry, { max: 260 }),
  username: S.str(/^[A-Za-z0-9._@-]{1,128}$/, { max: 128 }),
  password: S.text(16_384),
});

/** command name → the schema of its `args`. Nothing else can be sent (R5). */
export const COMMANDS = {
  'facts.get': {},
  'network.ensure': { name: S.str(RULES.network), labels: S.labels() },
  'image.build': {
    tag: S.str(RULES.image, { max: 200 }),
    labels: S.labels(),
    source: S.obj({
      repo: S.fn(isRepoUrl, 'An https:// Git URL without credentials, or a file:// path.'),
      branch: S.fn(isBranch, 'A Git branch name.'),
      commit: S.str(RULES.commit, { optional: true, max: 40 }),
      rootDir: S.fn(isRootDir, 'A folder inside the repository.', { optional: true }),
    }),
    runtime: S.fn((v) => RUNTIMES.includes(v), `One of ${RUNTIMES.join(', ')}.`),
    buildCommand: S.str(/^[^\r\n]*$/, { optional: true, max: 500 }),
    startCommand: S.str(/^[^\r\n]*$/, { optional: true, max: 500 }),
    gitToken: S.text(4096, { optional: true }),
    /** Variables the service marks "available during the build" (spec 8.3 R5); masked in the log. */
    buildEnv: S.env(),
    /** The build's time limit (spec 8.3 R2): 15 minutes unless the builder pool says otherwise. */
    timeoutS: S.int(60, 7200, { optional: true }),
    /** Values to hide in the build log (tokens, secrets). */
    mask: S.strings(100, 32_768),
    stream: S.str(RULES.stream),
  },
  'image.push': { tag: S.str(RULES.image, { max: 200 }), ref: S.str(RULES.ref, { max: 400 }), auth: registryAuth, stream: S.str(RULES.stream) },
  'image.pull': { ref: S.str(RULES.ref, { max: 400 }), tag: S.str(RULES.image, { max: 200 }), auth: { ...registryAuth, optional: true }, stream: S.str(RULES.stream) },
  'image.remove': { tag: S.str(RULES.image, { max: 200 }) },
  /**
   * Spec 8.8: a static site's built files. A container is created from the image (never started), `dir` (in the
   * image's working directory) is copied out as a tar, sent in `chunk` frames on `stream`, and the container removed.
   * Answers { bytes, sha256 } of the whole tar.
   */
  'site.export': {
    tag: S.str(RULES.image, { max: 200 }),
    labels: S.labels(),
    dir: S.fn(isPublishDir, 'A folder inside the build, such as dist, or . for all of it.'),
    maxBytes: S.int(1, MAX_EXPORT_BYTES),
    stream: S.str(RULES.stream),
  },
  /** Spec 8.4: the whole ingress config, as data the agent renders (ingress.js). Ingress pool VMs only. */
  'ingress.sync': {
    sites: S.list(S.obj({
      id: S.str(RULES.site, { max: 100 }),
      hosts: S.list(S.str(RULES.host, { max: 253 }), 25),
      upstreams: S.list(S.str(RULES.upstream, { max: 21 }), 100),
      health: S.obj({ path: S.str(/^\/[^\s]{0,500}$/, { max: 501 }) }, { optional: true }),
      sleeping: S.bool(),
    }), 5000),
    wildcard: S.obj({
      domain: S.str(RULES.host, { max: 253 }),
      provider: S.fn((v) => ['googleclouddns', 'route53'].includes(v), 'googleclouddns or route53.'),
      project: S.str(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, { optional: true, max: 30 }),
      zone: S.str(/^[A-Z0-9]{1,32}$/, { optional: true, max: 32 }),
    }, { optional: true }),
    ask: S.str(RULES.hookUrl, { optional: true, max: 500 }),
    wake: S.str(RULES.hookUrl, { optional: true, max: 500 }),
  },
  /** Spec 8.4 R7: per-host request and byte totals since Caddy started. */
  'ingress.counters': {},
  /** A relay on a tenant network's gateway to a database server the agent was told it may reach (spec 8.6 R2). */
  'relay.ensure': { network: S.str(RULES.network), target: S.str(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}:\d{1,5}$/, { max: 260 }), port: S.int(1024, 65535, { optional: true }), databases: S.strings(500, 63) },
  'relay.remove': { network: S.str(RULES.network) },
  'container.run': runShape,
  'container.stop': { name: container, timeoutS: S.int(0, 120, { optional: true }) },
  'container.remove': { name: container },
  'container.list': { labels: S.labels() },
  'health.check': { name: container, port: S.int(1, 65_535), path: S.str(/^\/[^\s]{0,500}$/, { max: 501 }), timeoutS: S.int(1, 60, { optional: true }) },
  'job.run': { ...runShape, port: undefined, hostPort: undefined, timeoutS: S.int(1, 86_400, { optional: true }), stream: S.str(RULES.stream) },
  'logs.follow': { name: container, stream: S.str(RULES.stream), since: S.str(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, { optional: true, max: 40 }) },
  'logs.stop': { stream: S.str(RULES.stream) },
  'stats.watch': { labels: S.labels(), intervalS: S.int(5, 60, { optional: true }), stream: S.str(RULES.stream) },
};
for (const shape of Object.values(COMMANDS)) for (const k of Object.keys(shape)) if (shape[k] === undefined) delete shape[k];

/** The problems with a command's args ([] when it may run). */
export function checkCommand(name, args) {
  const shape = COMMANDS[name];
  if (!shape) return [{ path: 'name', message: `Unknown command ${String(name).slice(0, 40)}.` }];
  const problems = [];
  check(args ?? {}, { kind: 'obj', shape, optional: false }, 'args', problems);
  if (name === 'container.run' && (args?.hostPort !== undefined) !== (args?.port !== undefined)) {
    problems.push({ path: 'args.hostPort', message: 'A host port goes with a container port.' });
  }
  if ((name === 'container.run' || name === 'job.run') && Array.isArray(args?.aliases)) {
    if (args.aliases.length && !args.network) problems.push({ path: 'args.aliases', message: 'Private names need the tenant\'s network.' });
    args.aliases.forEach((a, i) => { if (typeof a !== 'string' || !RULES.alias.test(a)) problems.push({ path: `args.aliases.${i}`, message: 'A name such as api.acme.internal.' }); });
  }
  return problems;
}

// ---- frames ---------------------------------------------------------------------------------------------

/**
 * Frame type → the fields it must carry. `from` says who may send it ('agent' | 'controller').
 * hello/enrol are the agent's first frame (nothing else before it); welcome/refused answer it.
 */
export const FRAMES = {
  hello: { from: 'agent', fields: { server: S.str(/^srv_[a-z0-9]{8,32}$/, { max: 40 }), credential: S.str(/^[A-Za-z0-9_-]{43}$/, { max: 43 }), agentVersion: S.text(20), facts: S.obj({}, { optional: true }) } },
  enrol: { from: 'agent', fields: { token: S.str(/^enr_[A-Za-z0-9_-]{32,64}$/, { max: 70 }), agentVersion: S.text(20), facts: S.obj({}, { optional: true }) } },
  welcome: { from: 'controller', fields: { install: S.str(/^[A-Za-z0-9_-]{4,80}$/, { max: 80 }), server: S.str(/^srv_[a-z0-9]{8,32}$/, { max: 40 }), credential: S.str(/^[A-Za-z0-9_-]{43}$/, { optional: true, max: 43 }), expectedAgentVersion: S.text(20), heartbeatMs: S.int(1000, 120_000) } },
  /** retry: whether the agent should try again later (true when the controller is stopping or was slow; false when the credential is refused). */
  refused: { from: 'controller', fields: { reason: S.text(300), retry: S.bool() } },
  heartbeat: { from: 'agent', fields: {} },
  facts: { from: 'agent', fields: {} },
  command: { from: 'controller', fields: { name: S.text(40) } },
  result: { from: 'agent', fields: {} },
  error: { from: 'agent', fields: { code: S.text(40), message: S.text(1000) } },
  log: { from: 'agent', fields: { stream: S.str(RULES.stream), seq: S.int(0, Number.MAX_SAFE_INTEGER), lines: { kind: 'lines', optional: false } } },
  stats: { from: 'agent', fields: { stream: S.str(RULES.stream), seq: S.int(0, Number.MAX_SAFE_INTEGER) } },
  'stream-end': { from: 'agent', fields: { stream: S.str(RULES.stream) } },
  /** Spec 8.8: part of a site export, in order (seq from 0); data is base64. */
  chunk: { from: 'agent', fields: { stream: S.str(RULES.stream), seq: S.int(0, Number.MAX_SAFE_INTEGER), data: S.text(Math.ceil(CHUNK_BYTES / 3) * 4) } },
  bye: { from: 'controller', fields: { reason: S.text(300), retry: S.bool() } },
};
// 'facts' and 'stats' carry open objects (checked by the controller when stored); 'lines' is checked below.
for (const f of ['facts']) FRAMES[f].open = true;
FRAMES.stats.open = true;
FRAMES.result.open = true;
FRAMES.hello.fields.facts = { kind: 'any', optional: true };
FRAMES.enrol.fields.facts = { kind: 'any', optional: true };

function checkLines(lines, problems) {
  if (!Array.isArray(lines) || lines.length > 500) return problems.push({ path: 'lines', message: 'Up to 500 lines a frame.' });
  lines.forEach((l, i) => {
    if (typeof l?.line !== 'string' || l.line.length > MAX_LOG_LINE + CUT_MARK.length) problems.push({ path: `lines.${i}.line`, message: 'A line of up to 16 KB.' });
    if (!['stdout', 'stderr', 'build'].includes(l?.out)) problems.push({ path: `lines.${i}.out`, message: 'stdout, stderr or build.' });
    if (typeof l?.at !== 'string' || l.at.length > 40) problems.push({ path: `lines.${i}.at`, message: 'A timestamp.' });
  });
}

/** Checks a decoded frame; throws ProtocolError. `from` is who sent it. */
export function checkFrame(frame, from) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new ProtocolError('bad_frame', 'A frame is a JSON object.');
  if (frame.v !== PROTOCOL_VERSION) throw new ProtocolError('bad_version', `Protocol version ${PROTOCOL_VERSION} only.`);
  const spec = FRAMES[frame.type];
  if (!spec) throw new ProtocolError('unknown_type', `Unknown frame type ${String(frame.type).slice(0, 40)}.`);
  if (from && spec.from !== from) throw new ProtocolError('bad_frame', `A ${frame.type} frame comes from the ${spec.from}.`);
  if (frame.id !== undefined && (typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(frame.id))) throw new ProtocolError('bad_frame', 'A frame id is up to 40 letters, digits, - or _.');
  const problems = [];
  for (const [key, rule] of Object.entries(spec.fields)) {
    if (rule.kind === 'any') continue;
    if (rule.kind === 'lines') {
      checkLines(frame.lines, problems);
      continue;
    }
    check(frame[key], rule, key, problems);
  }
  if (frame.type === 'command') problems.push(...checkCommand(frame.name, frame.args));
  if (['command', 'result', 'error'].includes(frame.type) && !frame.id) problems.push({ path: 'id', message: 'Requests and their answers carry an id.' });
  if (problems.length) throw new ProtocolError('invalid', `The ${frame.type} frame is not valid.`, problems);
  return frame;
}

/** Frame → text, refusing anything over the limit (R12). */
export function encode(frame) {
  const text = JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError('too_large', 'The frame is over 1 MB.');
  return text;
}

/** Text → a checked frame. `from` is the side that sent it. */
export function decode(text, from) {
  const raw = typeof text === 'string' ? text : Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new ProtocolError('too_large', 'The frame is over 1 MB.');
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    throw new ProtocolError('bad_json', 'The frame is not JSON.');
  }
  return checkFrame(frame, from);
}

/** Cuts a log line to MAX_LOG_LINE and marks it (8.5 R3). */
export function cutLine(line) {
  const s = String(line);
  return s.length > MAX_LOG_LINE ? s.slice(0, MAX_LOG_LINE) + CUT_MARK : s;
}

/** Replaces every masked value in a line with •••• (R8: secrets never reach a log). Values under 4 characters are left. */
export function maskLine(line, mask = []) {
  let out = String(line);
  for (const m of mask) if (typeof m === 'string' && m.length >= 4) out = out.split(m).join('••••');
  return out;
}
