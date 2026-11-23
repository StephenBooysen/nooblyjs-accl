import crypto from 'node:crypto';
import { dockerfileFor, BASES } from './docker.js';
import { pack } from './tar.js';

// Docker, faked in memory (spec 8.9.1, "Mock and tests"): the same interface as docker.js (8.9.5), so the mock agent
// runs the real agent session over it. Containers keep their run arguments, so tests can check the limits and flags
// the controller asked for; `emit()` writes a log line as if the container printed it; `failNext()` makes the next
// call of an operation fail; `crash()` makes a container exit as Docker's restart policy sees it; `resolve()` answers a
// private name as Docker's DNS would on the networks a container is on; `holdJobs()` keeps jobs running until let go,
// and `holdBuilds()` builds. Pushes and pulls go to `registry` (the mock cloud's, spec 8.3): { push(ref, image, auth),
// pull(ref, auth) → image | null }; without one, a pull of a public reference just works. `siteFiles(fn)` sets what a
// static site's export finds (spec 8.8): fn(args) → [{ path, data }] under the publish directory, or null for none.

/**
 * @param {{ facts?: object, now?: () => number, registry?: object, network?: Map<string, object> }} [o]
 *   `network`: address → mock Docker, shared by the mock servers of one controller, so a mock ingress (spec 8.4) can
 *   reach containers on other mock hosts by their private address and published port.
 */
export function createMockDocker({ facts = {}, now = () => Date.now(), registry = null, network = null, relayTargets = null } = {}) {
  const relays = new Map();
  const networks = new Map();
  const images = new Map();
  const containers = new Map(); // name → { name, labels, state, args, lines: [{ out, at, line }], followers: Set }
  const failures = new Map(); // op → message
  const iso = () => new Date(now()).toISOString();
  let jobsRunning = 0;
  let peakJobs = 0;
  const jobsRun = []; // each job.run's { name, env, command }, oldest first (tests read them)
  let jobGate = null;
  let buildsRunning = 0;
  let peakBuilds = 0;
  let buildGate = null;
  const dockerfiles = new Map(); // tag → the Dockerfile it was built from (tests read it)
  let ingress = null; // the last ingress.sync's arguments (a mock ingress VM)
  const served = {}; // host → { requests, bytesOut, errors }
  const turn = new Map(); // site id → round-robin position
  let siteFilesOf = null; // (args) → [{ path, data }] | null: a static site's built files (spec 8.8)
  const exports = []; // each site.export's { tag, dir }, oldest first

  /** A small built site: an index page naming the image, a hashed script and an about page. */
  function defaultSite(args) {
    const h = `a1${crypto.createHash('sha256').update(args.tag).digest('hex').slice(0, 6)}`;
    return [
      { path: 'index.html', data: `<!doctype html><title>Site</title><h1>Built from ${args.tag}</h1><script src="./assets/app-${h}.js"></script>` },
      { path: `assets/app-${h}.js`, data: `console.log(${JSON.stringify(args.tag)});` },
      { path: 'about.html', data: '<!doctype html><title>About</title><p>About.</p>' },
    ];
  }

  const fail = (op) => {
    const f = failures.get(op);
    if (!f) return;
    if (f.after > 0) {
      f.after -= 1;
      return;
    }
    failures.delete(op);
    throw new Error(f.message);
  };

  function write(c, out, line) {
    const entry = { out, at: iso(), line };
    c.lines.push(entry);
    if (c.lines.length > 5000) c.lines.shift();
    for (const f of c.followers) f.onLine(out, line, entry.at);
  }

  const view = (c) => ({ name: c.name, labels: c.labels, state: c.state, image: c.args.image, hostPort: c.args.hostPort ?? null, startedAt: c.startedAt });

  /** A build as the real one logs it: clone, the template (rendered, so its slots are checked), the commands, the tag. */
  async function mockBuild(args, onLine) {
    const { source } = args;
    onLine(`Cloning ${source.repo} (${source.branch})${source.commit ? ` at ${source.commit}` : ''}`);
    if (args.gitToken) onLine(`Using credentials ${args.gitToken}`); // the agent must mask this
    if (args.buildEnv?.length) onLine(`With ${args.buildEnv.length} build-time variable${args.buildEnv.length === 1 ? '' : 's'}: ${args.buildEnv.map((e) => e.key).join(', ')}`);
    for (const e of args.buildEnv ?? []) onLine(`${e.key}=${e.value}`); // as a careless build script would print it; the agent masks it
    if (args.runtime === 'dockerfile') onLine('Building from the repository\'s Dockerfile');
    else {
      dockerfiles.set(args.tag, dockerfileFor(args.runtime, args));
      onLine(`Building with the ${args.runtime} template (${BASES[args.runtime]})${source.rootDir ? ` in ${source.rootDir}` : ''}`);
    }
    if (args.buildCommand) onLine(`> ${args.buildCommand}`);
    if (buildGate) await buildGate.promise;
    if (/\bfail-build\b/.test(args.buildCommand ?? '')) {
      onLine('npm ERR! missing script: build');
      throw new Error('The image build failed; the lines above say why.');
    }
    onLine(`Built ${args.tag}`);
    images.set(args.tag, { tag: args.tag, labels: args.labels, builtAt: iso() });
    // Like a real build: the commit it built (the one asked for, or the branch's latest).
    const commit = source.commit ?? crypto.createHash('sha1').update(`${source.repo}#${source.branch}`).digest('hex');
    return { tag: args.tag, commit };
  }

  const api = {
    kind: 'mock',
    facts: async () => ({
      hostname: 'mock-server', os: 'Ubuntu 24.04.5 LTS', kernel: '6.8.0', cpus: 4, memoryMb: 8192, diskFreeGb: 40,
      docker: '29.0.0-mock', cgroup: 2, security: { userns: false, rootless: false, apparmor: true, seccomp: true },
      egressFirewall: { applied: true, version: 1, at: '2026-11-23T00:00:00.000Z' },
      addresses: ['192.168.1.20'], ...facts,
    }),

    async ensureNetwork(name, labels) {
      fail('network.ensure');
      if (!networks.has(name)) networks.set(name, { name, labels });
      return { name, created: true };
    },

    async build(args, onLine) {
      fail('image.build');
      buildsRunning += 1;
      peakBuilds = Math.max(peakBuilds, buildsRunning);
      try {
        return await mockBuild(args, onLine);
      } finally {
        buildsRunning -= 1;
      }
    },

    async push(args, onLine) {
      fail('image.push');
      const image = images.get(args.tag);
      if (!image) throw new Error(`No image ${args.tag} on this server.`);
      onLine(`Pushing to ${args.ref.split('/')[0]}`);
      const digest = `sha256:${crypto.createHash('sha256').update(`${args.ref}#${image.builtAt}#${args.tag}`).digest('hex')}`;
      if (registry) await registry.push(args.ref, { ...image, digest }, args.auth);
      onLine(`Pushed ${args.ref}`);
      return { ref: args.ref, digest };
    },

    async pull(args, onLine) {
      fail('image.pull');
      onLine(`Pulling ${args.ref}`);
      const found = registry ? await registry.pull(args.ref, args.auth ?? null) : { labels: {}, digest: null };
      if (!found) throw new Error(`Error response from daemon: manifest for ${args.ref} not found, or no pull access.`);
      images.set(args.tag, { tag: args.tag, labels: found.labels ?? {}, builtAt: iso(), from: args.ref, digest: found.digest ?? null });
      return { tag: args.tag, id: found.digest ?? `sha256:${'0'.repeat(64)}` };
    },

    async removeImage(tag) {
      const removed = images.delete(tag);
      return { tag, removed };
    },

    /** Like docker.js: the publish directory as a tar under its own folder name, in chunks. */
    async exportSite(args, onChunk) {
      fail('site.export');
      if (!images.has(args.tag)) throw new Error(`Error response from daemon: No such image: ${args.tag}`);
      exports.push({ tag: args.tag, dir: args.dir });
      const files = siteFilesOf ? siteFilesOf(args) : defaultSite(args);
      if (!files) throw new Error(`There is no ${args.dir} folder after the build: check that the build command writes the site there.`);
      const root = args.dir === '.' ? 'app' : args.dir.split('/').at(-1);
      const tar = pack([{ path: root, type: '5' }, ...files.map((f) => ({ ...f, path: `${root}/${f.path}` }))]);
      if (tar.length > args.maxBytes) throw new Error(`The publish directory is over ${Math.round(args.maxBytes / 1048576)} MB.`);
      const size = args.chunkBytes ?? 512 * 1024;
      for (let i = 0; i < tar.length; i += size) onChunk(tar.subarray(i, i + size));
      return { bytes: tar.length, sha256: crypto.createHash('sha256').update(tar).digest('hex') };
    },
    /** What the next static site exports find: fn(args) → [{ path, data }], or null for "no such folder". */
    /** Relays (spec 8.6 R2): a made-up gateway per network, from the targets it was given (all, when none were). */
    async relayEnsure({ network, target, port = 15432, databases = [] }) {
      fail('relay.ensure');
      if (relayTargets && !relayTargets.includes(target)) throw Object.assign(new Error(`This agent does not relay to ${target}. Start it with --relay-target ${target}.`), { code: 'refused' });
      if (!networks.has(network)) throw new Error(`There is no network ${network} here.`);
      const i = [...networks.keys()].indexOf(network);
      const r = { host: `172.${30 + (i % 200)}.0.1`, port, subnet: `172.${30 + (i % 200)}.0.0/16`, target, databases: [...databases] };
      relays.set(network, r);
      return { host: r.host, port: r.port, subnet: r.subnet };
    },
    async relayRemove({ network }) {
      return { removed: relays.delete(network) };
    },
    get relays() {
      return [...relays.entries()].map(([network, r]) => ({ network, ...r }));
    },

    siteFiles(fn) {
      siteFilesOf = fn;
    },
    /** The site exports so far: { tag, dir }. */
    get exports() {
      return exports;
    },

    async ingressSync(a) {
      fail('ingress.sync');
      ingress = structuredClone(a);
      return { sites: a.sites.length };
    },

    async ingressCounters() {
      return structuredClone(served);
    },

    /**
     * For tests, on a mock ingress VM: a request to `host` as Caddy would route it. Upstreams are tried round-robin;
     * one whose container is not running is skipped (the health checks and retries); none left is a 502.
     */
    request(host, path = '/', { bytes = 512 } = {}) {
      const count = (status) => {
        const row = (served[host] ??= { requests: 0, bytesOut: 0, errors: 0 });
        row.requests += 1;
        if (status === 200) row.bytesOut += bytes;
        if (status >= 500) row.errors += 1;
      };
      const site = ingress?.sites.find((s) => s.hosts.includes(host));
      if (!site) return { status: 404 };
      if (site.sleeping && ingress.wake) {
        count(307);
        return { status: 307, location: `${ingress.wake}?host=${host}&path=${path}` };
      }
      const n = site.upstreams.length;
      const start = turn.get(site.id) ?? 0;
      for (let k = 0; k < n; k += 1) {
        const dial = site.upstreams[(start + k) % n];
        const [ip, port] = dial.split(':');
        const c = network?.get(ip)?.serving(Number(port));
        if (!c) continue;
        turn.set(site.id, (start + k + 1) % n);
        count(200);
        return { status: 200, upstream: dial, container: c.name };
      }
      count(n ? 502 : 503);
      return { status: n ? 502 : 503 };
    },
    /** The running container published on `port` here (a mock ingress asks it). */
    serving(port) {
      return [...containers.values()].find((c) => c.state === 'running' && c.args.hostPort === port) ?? null;
    },
    get ingress() {
      return ingress;
    },

    async run(args) {
      fail('container.run');
      if (!images.has(args.image)) throw new Error(`No image ${args.image} on this server.`);
      const c = { name: args.name, labels: args.labels, state: 'running', args, lines: [], followers: new Set(), startedAt: iso(), restarts: 0, exitCode: null };
      containers.set(args.name, c);
      write(c, 'stdout', `Listening on port ${args.port ?? 'none'}`);
      return { name: args.name, state: 'running', hostPort: args.hostPort ?? null };
    },

    async inspect(name) {
      const c = containers.get(name);
      return c ? view(c) : null;
    },

    async stop(name) {
      fail('container.stop');
      const c = containers.get(name);
      c.state = 'exited';
      return { name, state: 'exited' };
    },

    async remove(name) {
      fail('container.remove');
      const c = containers.get(name);
      for (const f of c.followers) f.onEnd();
      containers.delete(name);
      return { name, removed: true };
    },

    async list(labels) {
      return [...containers.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v)).map(view);
    },

    async health(name, port, path) {
      fail('health.check');
      const c = containers.get(name);
      return { ok: c.state === 'running', status: c.state === 'running' ? 200 : 0, path };
    },

    async job(args, onLine) {
      fail('job.run');
      if (!images.has(args.image)) throw new Error(`No image ${args.image} on this server.`);
      jobsRun.push({ name: args.name, env: (args.env ?? []).map((e) => ({ ...e })), command: args.command ?? null });
      jobsRunning += 1;
      peakJobs = Math.max(peakJobs, jobsRunning);
      try {
        onLine('stdout', `Running ${args.command?.join(' ') ?? 'the image\'s command'}`);
        if (jobGate) await jobGate.promise;
        const exitCode = /exit (\d+)/.exec(args.command?.join(' ') ?? '')?.[1];
        onLine('stdout', 'Done');
        return { exitCode: exitCode ? Number(exitCode) : 0, durationMs: 5, peakMemoryMb: 32 };
      } finally {
        jobsRunning -= 1;
      }
    },

    /** Replays lines from `since` (inclusive, like `docker logs --since`), then follows. Returns stop(). */
    async logs(name, { since }, onLine, onEnd) {
      const c = containers.get(name);
      for (const l of c.lines) if (!since || l.at >= since) onLine(l.out, l.line, l.at);
      const follower = { onLine, onEnd };
      c.followers.add(follower);
      return () => c.followers.delete(follower);
    },

    async states(labels) {
      return [...containers.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v))
        .map((c) => ({ name: c.name, state: c.state, exitCode: c.exitCode, restarts: c.restarts }));
    },

    /**
     * What `docker stats` would say. Unless a test set the usage (setUsage), CPU and memory drift slowly within the
     * container's limits and the network counters grow, so a demo's charts move (they are not real numbers).
     */
    async stats(labels) {
      const nowS = Date.now() / 1000;
      return (await this.list(labels)).filter((c) => c.state === 'running').map((c) => {
        const rec = containers.get(c.name);
        const { args, usage } = rec;
        rec.statsFrom ??= nowS;
        const phase = [...c.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) / 97;
        const wave = (periodS) => (1 + Math.sin(nowS / periodS + phase)) / 2;
        const up = Math.max(1, nowS - rec.statsFrom);
        return {
          name: c.name, cpuLimit: args.cpu, memoryLimitMb: args.memoryMb, pids: 7,
          cpu: Math.round((args.cpu ?? 1) * (0.04 + 0.3 * wave(45)) * 1000) / 1000,
          memoryMb: Math.round((args.memoryMb ?? 512) * (0.18 + 0.12 * wave(240))),
          rxBytes: Math.round(1024 + up * 700), txBytes: Math.round(2048 + up * 2100),
          ...usage,
        };
      });
    },
    /** Test hook: what stats() reports for a container from now on (cpu, memoryMb, rxBytes, txBytes). */
    setUsage(name, usage) {
      const c = containers.get(name);
      if (c) c.usage = { ...c.usage, ...usage };
    },

    // ---- for tests ------------------------------------------------------------------------------
    /**
     * The container exits with `exitCode`; Docker restarts it up to 5 times (on-failure:5), then leaves it exited.
     * Like `docker logs --follow`, a follow ends when the container stops; lines written after the restart wait for
     * the next follow (emit() them after crash()).
     */
    crash(name, exitCode = 1) {
      const c = containers.get(name);
      c.exitCode = exitCode;
      if (c.restarts >= 5) c.state = 'exited';
      else c.restarts += 1;
      write(c, 'stderr', `exited with code ${exitCode}`);
      for (const f of [...c.followers]) f.onEnd();
      c.followers.clear();
    },
    /** What `host` resolves to from container `from`: a running container with that alias on a network `from` is on. */
    resolve(from, host) {
      const a = containers.get(from);
      if (!a?.args.network) return null;
      const b = [...containers.values()].find((c) => c.state === 'running' && c.args.network === a.args.network && (c.args.aliases ?? []).includes(host));
      return b?.name ?? null;
    },
    /** Jobs wait until the returned function is called. */
    holdJobs() {
      let open;
      jobGate = { promise: new Promise((r) => { open = r; }) };
      return () => { jobGate = null; open(); };
    },
    get peakJobs() {
      return peakJobs;
    },
    /** The job runs so far, oldest first: { name, env, command }. */
    get jobs() {
      return jobsRun;
    },
    /** Builds wait until the returned function is called (a second call while held returns the same one). */
    holdBuilds() {
      if (!buildGate) {
        let open;
        const promise = new Promise((r) => { open = r; });
        buildGate = { promise, open: () => { if (buildGate?.promise === promise) buildGate = null; open(); } };
      }
      return buildGate.open;
    },
    get peakBuilds() {
      return peakBuilds;
    },
    get buildsRunning() {
      return buildsRunning;
    },
    /** The Dockerfile an image was built from (template builds). */
    dockerfile: (tag) => dockerfiles.get(tag) ?? null,
    emit(name, line, out = 'stdout') {
      write(containers.get(name), out, line);
    },
    /** The next call of `op` fails (or the one after `after` more succeed). */
    failNext(op, message = `${op} failed (injected).`, { after = 0 } = {}) {
      failures.set(op, { message, after });
    },
    get state() {
      return { networks: [...networks.keys()], images: [...images.keys()], containers: [...containers.values()].map((c) => ({ ...view(c), args: c.args })) };
    },
  };
  for (const address of facts.addresses ?? []) network?.set(address, api);
  return api;
}
