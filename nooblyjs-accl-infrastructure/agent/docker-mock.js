import crypto from 'node:crypto';

// Docker, faked in memory (spec 8.9.1, "Mock and tests"): the same interface as docker.js (8.9.5), so the mock agent
// runs the real agent session over it. Containers keep their run arguments, so tests can check the limits and flags
// the controller asked for; `emit()` writes a log line as if the container printed it; `failNext()` makes the next
// call of an operation fail.

/** @param {{ facts?: object, now?: () => number }} [o] */
export function createMockDocker({ facts = {}, now = () => Date.now() } = {}) {
  const networks = new Map();
  const images = new Map();
  const containers = new Map(); // name → { name, labels, state, args, lines: [{ out, at, line }], followers: Set }
  const failures = new Map(); // op → message
  const iso = () => new Date(now()).toISOString();

  const fail = (op) => {
    if (!failures.has(op)) return;
    const message = failures.get(op);
    failures.delete(op);
    throw new Error(message);
  };

  function write(c, out, line) {
    const entry = { out, at: iso(), line };
    c.lines.push(entry);
    if (c.lines.length > 5000) c.lines.shift();
    for (const f of c.followers) f.onLine(out, line, entry.at);
  }

  const view = (c) => ({ name: c.name, labels: c.labels, state: c.state, image: c.args.image, hostPort: c.args.hostPort ?? null, startedAt: c.startedAt });

  return {
    kind: 'mock',
    facts: async () => ({
      hostname: 'mock-server', os: 'Ubuntu 24.04.5 LTS', kernel: '6.8.0', cpus: 4, memoryMb: 8192, diskFreeGb: 40,
      docker: '29.0.0-mock', cgroup: 2, security: { userns: false, rootless: false, apparmor: true, seccomp: true },
      addresses: ['192.168.1.20'], ...facts,
    }),

    async ensureNetwork(name, labels) {
      fail('network.ensure');
      if (!networks.has(name)) networks.set(name, { name, labels });
      return { name, created: true };
    },

    async build(args, onLine) {
      fail('image.build');
      const { source } = args;
      onLine(`Cloning ${source.repo} (${source.branch})${source.commit ? ` at ${source.commit}` : ''}`);
      if (args.gitToken) onLine(`Using credentials ${args.gitToken}`); // the agent must mask this
      onLine(`Runtime ${args.runtime}${source.rootDir ? ` in ${source.rootDir}` : ''}`);
      if (args.buildCommand) onLine(`> ${args.buildCommand}`);
      onLine(`Built ${args.tag}`);
      images.set(args.tag, { tag: args.tag, labels: args.labels, builtAt: iso() });
      // Like a real build: the commit it built (the one asked for, or the branch's latest).
      const commit = source.commit ?? crypto.createHash('sha1').update(`${source.repo}#${source.branch}`).digest('hex');
      return { tag: args.tag, commit };
    },

    async run(args) {
      fail('container.run');
      if (!images.has(args.image)) throw new Error(`No image ${args.image} on this server.`);
      const c = { name: args.name, labels: args.labels, state: 'running', args, lines: [], followers: new Set(), startedAt: iso() };
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
      onLine('stdout', `Running ${args.command?.join(' ') ?? 'the image\'s command'}`);
      onLine('stdout', 'Done');
      return { exitCode: 0, durationMs: 5, peakMemoryMb: 32 };
    },

    /** Replays lines from `since` (inclusive, like `docker logs --since`), then follows. Returns stop(). */
    async logs(name, { since }, onLine, onEnd) {
      const c = containers.get(name);
      for (const l of c.lines) if (!since || l.at >= since) onLine(l.out, l.line, l.at);
      const follower = { onLine, onEnd };
      c.followers.add(follower);
      return () => c.followers.delete(follower);
    },

    async stats(labels) {
      return (await this.list(labels)).filter((c) => c.state === 'running').map((c) => {
        const { args, usage } = containers.get(c.name);
        return { name: c.name, cpu: 0.02, cpuLimit: args.cpu, memoryMb: 48, memoryLimitMb: args.memoryMb, rxBytes: 1024, txBytes: 2048, pids: 7, ...usage };
      });
    },
    /** Test hook: what stats() reports for a container from now on (cpu, memoryMb, rxBytes, txBytes). */
    setUsage(name, usage) {
      const c = containers.get(name);
      if (c) c.usage = { ...c.usage, ...usage };
    },

    // ---- for tests ------------------------------------------------------------------------------
    emit(name, line, out = 'stdout') {
      write(containers.get(name), out, line);
    },
    failNext(op, message = `${op} failed (injected).`) {
      failures.set(op, message);
    },
    get state() {
      return { networks: [...networks.keys()], images: [...images.keys()], containers: [...containers.values()].map((c) => ({ ...view(c), args: c.args })) };
    },
  };
}
