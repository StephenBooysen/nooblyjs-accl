// Docker on this server, for the agent (spec 8.9 R6, R8, R11). The same interface as docker-mock.js. It runs the
// `docker` and `git` command-line tools with fixed argument lists through spawn() and never a shell, so no value the
// controller sends can become a command; protocol.js has already checked every value before it gets here.
//
// Builds: clone the repository into a temporary folder, write the runtime's Dockerfile next to it (outside the build
// context), `docker build` it, delete the folder. Containers: the R6 limits and hardening on every `docker run`.
// Environment values go through an --env-file (0600) that is deleted as soon as the container is created.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caddyConfig, parseMetrics } from './ingress.js';

/** The runtime templates' base images, pinned by digest (spec 8.3.1; runtimes/bases.json, refreshed by a script). */
const RUNTIMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtimes');
export const BASES = JSON.parse(readFileSync(path.join(RUNTIMES_DIR, 'bases.json'), 'utf8')).bases;
const TEMPLATES = Object.fromEntries(['node22', 'python312', 'go123'].map((r) => [r, readFileSync(path.join(RUNTIMES_DIR, `${r}.Dockerfile`), 'utf8')]));

/** Each runtime's build and start commands when the service gives none (spec 8.3 Design). */
export const DEFAULTS = {
  node22: {
    build: 'if [ -f package-lock.json ]; then npm ci; else npm install; fi && npm run build --if-present',
    start: 'npm start',
  },
  python312: {
    build: 'if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi',
    start: 'if command -v gunicorn >/dev/null 2>&1; then exec gunicorn --bind "0.0.0.0:${PORT:-8000}" app:app; else exec python app.py; fi',
  },
  go123: { build: 'go build -o /app/app .', start: '/app/app' },
};

/** Sources the build-time variables (a BuildKit secret, so in no layer: spec 8.3 R5) for the build command only. */
const WITH_BUILD_ENV = 'if [ -s /run/secrets/build-env ]; then set -a; . /run/secrets/build-env; set +a; fi; ';

/** A one-line shell command for a Dockerfile's RUN or CMD (protocol.js refuses newlines; this is the second check). */
const oneLine = (s) => {
  if (/[\r\n]/.test(s)) throw new Error('A build or start command is one line.');
  return s;
};

/**
 * The Dockerfile for a runtime template (spec 8.3 R1, 8.9 R8): the template's {{slots}} filled with JSON strings, so a
 * command stays one argument of an exec-form RUN or CMD whatever it contains. The app runs as an unprivileged user.
 */
export function dockerfileFor(runtime, { buildCommand, startCommand } = {}) {
  const template = TEMPLATES[runtime];
  if (!template) throw new Error(`No template for ${runtime}.`);
  const build = buildCommand ? oneLine(buildCommand) : DEFAULTS[runtime].build;
  const start = startCommand ? oneLine(startCommand) : DEFAULTS[runtime].start;
  const slots = { BASE: BASES[runtime], RUN_BASE: BASES.debian, BUILD_WITH_ENV: JSON.stringify(WITH_BUILD_ENV + build), START: JSON.stringify(start) };
  return template.split('\n').filter((l) => !l.startsWith('#')).join('\n').trimStart()
    .replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
      if (slots[k] === undefined) throw new Error(`The ${runtime} template has an unknown slot ${k}.`);
      return slots[k];
    });
}

/** The build-time variables as the shell file the template sources: KEY='value', quotes escaped (spec 8.3 R5). */
export function buildEnvFile(env = []) {
  return env.map((e) => `${e.key}='${String(e.value).replaceAll("'", "'\\''")}'\n`).join('');
}

/** The `docker run` arguments for container.run / job.run (R6). Exported so tests can check every flag. */
export function runArgs(a, { envFile = null, detach = true } = {}) {
  const args = ['run', detach ? '-d' : '--rm', '--name', a.name];
  for (const [k, v] of Object.entries(a.labels)) args.push('--label', `${k}=${v}`);
  if (a.network) args.push('--network', a.network);
  // The tenant's private names (spec 8.2 R5): Docker's DNS answers them only on this network.
  if (a.network) for (const alias of a.aliases ?? []) args.push('--network-alias', alias);
  args.push(
    '--cpus', String(a.cpu),
    '--memory', `${a.memoryMb}m`, '--memory-swap', `${a.memoryMb}m`,
    '--pids-limit', String(a.pidsLimit ?? 512),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
  );
  if (a.readOnly !== false) args.push('--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m');
  if (detach) args.push('--restart', 'on-failure:5');
  if (a.port && a.hostPort) args.push('-p', `${a.bind ?? '127.0.0.1'}:${a.hostPort}:${a.port}`);
  if (envFile) args.push('--env-file', envFile);
  args.push('--', a.image, ...(a.command ?? []));
  return args;
}

/**
 * Runs a program (never through a shell). Resolves { code, stdout, stderr }; `onLine(out, line)` sees lines as they come.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: object, input?: string, onLine?: (out: string, line: string) => void, keep?: boolean }} [o]
 */
export function exec(cmd, args, { cwd, env, input, onLine, keep = true, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal, killSignal: 'SIGTERM' } : {}) });
    const out = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      createInterface({ input: child[name] }).on('line', (line) => {
        if (keep && out[name].length < 1_000_000) out[name] += `${line}\n`;
        onLine?.(name, line);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ...out }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * The line of a failed command's stderr that says what went wrong: the last one that is not the CLI's usage text
 * ("Usage: …", "See 'docker run --help'.", "Run 'docker run --help' for more information"), which follows the cause.
 */
export function errorLine(stderr) {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !/^usage:/i.test(l) && !/--help'?\.?( for more information)?$/.test(l));
  return (useful.at(-1) ?? lines.at(-1) ?? '').replace(/^docker: /, '');
}

async function must(cmd, args, o) {
  const r = await exec(cmd, args, o);
  if (r.code !== 0) throw new Error((errorLine(r.stderr) || `${cmd} ${args[0]} failed`).slice(0, 500));
  return r;
}

/** "Labels" from `docker ps --format json`: "a=b,c=d". */
const parseLabels = (s) => Object.fromEntries(String(s ?? '').split(',').filter(Boolean).map((kv) => {
  const i = kv.indexOf('=');
  return [kv.slice(0, i), kv.slice(i + 1)];
}));

/** "12.5MiB / 512MiB" → MB. */
const toMb = (s) => {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/.exec(String(s).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = { B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1000, MiB: 1, MB: 1, GiB: 1024, GB: 1000, TiB: 1048576 }[m[2]] ?? 1;
  return Math.round(n * unit * 10) / 10;
};
/** "1.2kB", "3.4MB", "512B" (docker stats' NetIO, decimal units) → bytes. */
const toBytes = (s) => {
  const m = /^([\d.]+)\s*([kKMGT]?i?B)/.exec(String(s ?? '').trim());
  if (!m) return 0;
  const unit = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824, TB: 1e12 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * unit);
};

/**
 * @param {{ stateDir: string, docker?: string, git?: string }} o   stateDir holds env files while containers are created
 */
export function createDocker({ stateDir, docker = 'docker', git = 'git', caddyAdmin = 'http://127.0.0.1:2019' }) {
  const envDir = path.join(stateDir, 'env');

  /** Runs fn with a Docker config folder holding a registry login, deleted after (no credential stays on the server). */
  async function withLogin(auth, fn) {
    if (!auth) return fn([]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noobly-registry-'));
    try {
      await must(docker, ['--config', dir, 'login', `--username=${auth.username}`, '--password-stdin', '--', auth.server], { input: auth.password });
      return await fn(['--config', dir]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function inspect(name) {
    const r = await exec(docker, ['inspect', '--type', 'container', '--format', '{{json .}}', name]);
    if (r.code !== 0) return null;
    const c = JSON.parse(r.stdout);
    return {
      name: c.Name.replace(/^\//, ''),
      labels: c.Config?.Labels ?? {},
      state: c.State?.Status ?? 'unknown',
      exitCode: c.State?.ExitCode ?? null,
      image: c.Config?.Image ?? null,
      startedAt: c.State?.StartedAt ?? null,
      cpuLimit: c.HostConfig?.NanoCpus ? c.HostConfig.NanoCpus / 1e9 : null,
      memoryLimitMb: c.HostConfig?.Memory ? c.HostConfig.Memory / 1048576 : null,
      ports: c.NetworkSettings?.Ports ?? {},
    };
  }

  async function writeEnv(name, env = []) {
    if (!env.length) return null;
    for (const e of env) if (/[\r\n]/.test(e.value)) throw new Error(`${e.key}: values with line breaks are not supported yet.`);
    await fs.mkdir(envDir, { recursive: true, mode: 0o700 });
    const file = path.join(envDir, `${name}-${crypto.randomBytes(4).toString('hex')}.env`);
    await fs.writeFile(file, env.map((e) => `${e.key}=${e.value}\n`).join(''), { mode: 0o600 });
    return file;
  }

  /** `${container id}:${restart count}` → the exit code of the run before that restart (null if Docker did not say). */
  const exitCodes = new Map();
  /** The exit code in a restarted container's last `die` event, from the minutes before it started again. */
  async function diedWith(c, restarts) {
    const key = `${c.Id}:${restarts}`;
    if (exitCodes.has(key)) return exitCodes.get(key);
    const started = Math.floor(Date.parse(c.State?.StartedAt ?? '') / 1000);
    let code = null;
    if (Number.isFinite(started)) {
      const r = await exec(docker, ['events', '--since', String(started - 600), '--until', String(started + 1), '--filter', `container=${c.Id}`, '--filter', 'event=die', '--format', '{{.Actor.Attributes.exitCode}}']).catch(() => null);
      const last = String(r?.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).at(-1);
      code = last === undefined ? null : Number(last);
    }
    if (exitCodes.size > 1000) exitCodes.clear();
    exitCodes.set(key, code);
    return code;
  }

  return {
    kind: 'docker',

    async ensureNetwork(name, labels) {
      if ((await exec(docker, ['network', 'inspect', name])).code === 0) return { name, created: false };
      const args = ['network', 'create'];
      for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
      await must(docker, [...args, '--', name]);
      return { name, created: true };
    },

    async build(a, onLine) {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'noobly-build-'));
      try {
        const src = path.join(work, 'src');
        const repo = a.source.repo.startsWith('file:') ? new URL(a.source.repo).pathname : a.source.repo;
        // A Git token goes through Git's environment config, never the command line or the URL (R8).
        const gitEnv = { GIT_TERMINAL_PROMPT: '0' };
        if (a.gitToken) {
          Object.assign(gitEnv, {
            GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${a.gitToken}`).toString('base64')}`,
          });
        }
        onLine(`Cloning ${a.source.repo} (${a.source.branch})`);
        const cloned = await exec(git, ['clone', '--depth', '50', '--branch', a.source.branch, '--single-branch', '--', repo, src], { env: gitEnv, onLine: (_, l) => onLine(l) });
        if (cloned.code !== 0) throw new Error(`Could not clone ${a.source.repo} (${a.source.branch}). Is it public, and does the branch exist?`);
        if (a.source.commit) {
          const co = await exec(git, ['-C', src, 'checkout', '--quiet', a.source.commit]);
          if (co.code !== 0) onLine(`Commit ${a.source.commit} is not on ${a.source.branch}; building its latest commit`);
        }
        const commit = (await must(git, ['-C', src, 'rev-parse', 'HEAD'])).stdout.trim();
        onLine(`At commit ${commit.slice(0, 7)}`);
        const context = a.source.rootDir ? path.join(src, a.source.rootDir) : src;
        if (!(await fs.stat(context).catch(() => null))?.isDirectory()) throw new Error(`The repository has no folder ${a.source.rootDir}.`);

        const args = ['build', '--progress=plain', '-t', a.tag];
        for (const [k, v] of Object.entries(a.labels)) args.push('--label', `${k}=${v}`);
        // Build-time variables (spec 8.3 R5): a BuildKit secret the template sources for its build command, so they are
        // in no layer and no image history. A repository's Dockerfile can mount it too (id build-env).
        const envFile = path.join(work, 'build-env');
        await fs.writeFile(envFile, buildEnvFile(a.buildEnv), { mode: 0o600 });
        args.push('--secret', `id=build-env,src=${envFile}`);
        if (a.buildEnv?.length) onLine(`With ${a.buildEnv.length} build-time variable${a.buildEnv.length === 1 ? '' : 's'}: ${a.buildEnv.map((e) => e.key).join(', ')}`);
        if (a.runtime === 'dockerfile') {
          onLine('Building from the repository\'s Dockerfile');
        } else {
          const file = path.join(work, 'Dockerfile.noobly');
          await fs.writeFile(file, dockerfileFor(a.runtime, a));
          args.push('-f', file);
          onLine(`Building with the ${a.runtime} template (${BASES[a.runtime]})`);
        }
        // The time limit (spec 8.3 R2): the build is stopped when it runs over.
        const limitS = a.timeoutS ?? 900;
        let built;
        try {
          built = await exec(docker, [...args, '--', context], { onLine: (_, l) => onLine(l), keep: false, env: { DOCKER_BUILDKIT: '1' }, signal: AbortSignal.timeout(limitS * 1000) });
        } catch (err) {
          if (err.name === 'AbortError' || err.code === 'ABORT_ERR') throw new Error(`The build ran longer than its limit of ${Math.round(limitS / 60)} minutes and was stopped.`);
          throw err;
        }
        if (built.code !== 0) throw new Error('The image build failed; the lines above say why.');
        onLine(`Built ${a.tag}`);
        return { tag: a.tag, commit };
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    },

    /** Pushes a built image to the registry (spec 8.3 R3) with short-lived push credentials. Resolves { ref, digest }. */
    async push(a, onLine) {
      await must(docker, ['tag', a.tag, a.ref]);
      try {
        onLine(`Pushing to ${a.ref.split('/')[0]}`);
        await withLogin(a.auth, (cfg) => must(docker, [...cfg, 'push', '--quiet', '--', a.ref]));
        const digest = (await must(docker, ['image', 'inspect', '--format', '{{json .RepoDigests}}', a.ref])).stdout;
        const found = (JSON.parse(digest.trim() || '[]') ?? []).find((d) => d.startsWith(`${a.ref.replace(/:[^:/]+$/, '')}@`));
        onLine(`Pushed ${a.ref}`);
        return { ref: a.ref, digest: found?.split('@')[1] ?? null };
      } finally {
        await exec(docker, ['image', 'rm', '--no-prune', '--', a.ref]);
      }
    },

    /** Pulls an image (the registry's with read-only credentials, or a public one) and tags it as the controller's name for it. */
    async pull(a, onLine) {
      onLine(`Pulling ${a.ref}`);
      await withLogin(a.auth, (cfg) => must(docker, [...cfg, 'pull', '--quiet', '--', a.ref]));
      await must(docker, ['tag', a.ref, a.tag]);
      const id = (await must(docker, ['image', 'inspect', '--format', '{{.Id}}', a.tag])).stdout.trim();
      await exec(docker, ['image', 'rm', '--no-prune', '--', a.ref]);
      return { tag: a.tag, id };
    },

    /** Spec 8.4: loads the rendered config into Caddy through its admin API (ingress VMs run Caddy with --resume). */
    async ingressSync(a) {
      const config = caddyConfig(a);
      const res = await fetch(`${caddyAdmin}/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Caddy refused the config: ${(await res.text()).slice(0, 300)}`);
      return { sites: a.sites.length };
    },

    /** Spec 8.4 R7: per-host totals from Caddy's metrics. */
    async ingressCounters() {
      const res = await fetch(`${caddyAdmin}/metrics`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Caddy's metrics answered ${res.status}.`);
      return parseMetrics(await res.text());
    },

    /** Removes one of this install's image tags (an old version, spec 8.3 R6). */
    async removeImage(tag) {
      const r = await exec(docker, ['image', 'rm', '--', tag]);
      return { tag, removed: r.code === 0 };
    },

    /**
     * A static site's built files (spec 8.8 R1): a container is created from the image (never started), `dir` under
     * the image's working directory is copied out as a tar (`docker cp <c>:<dir> -`, so everything sits under the
     * folder's own name), handed to onChunk in pieces of up to `chunkBytes`, and the container removed. Stops at
     * maxBytes. → { bytes, sha256 }
     */
    async exportSite({ tag, labels, dir, maxBytes, chunkBytes = 512 * 1024 }, onChunk) {
      const work = (await must(docker, ['image', 'inspect', '--format', '{{.Config.WorkingDir}}', '--', tag])).stdout.trim() || '/';
      const from = dir === '.' ? work : path.posix.join(work, dir);
      const name = `noobly-export-${crypto.randomBytes(5).toString('hex')}`;
      const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      await must(docker, ['create', '--name', name, ...labelArgs, '--network', 'none', '--', tag]);
      try {
        return await new Promise((resolve, reject) => {
          const child = spawn(docker, ['cp', '--', `${name}:${from}`, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
          const hash = crypto.createHash('sha256');
          let bytes = 0;
          let pending = [];
          let pendingBytes = 0;
          let stderr = '';
          let failed = null;
          const flush = () => {
            if (!pendingBytes) return;
            const buf = Buffer.concat(pending, pendingBytes);
            pending = [];
            pendingBytes = 0;
            onChunk(buf);
          };
          child.stdout.on('data', (data) => {
            if (failed) return;
            bytes += data.length;
            if (bytes > maxBytes) {
              failed = new Error(`The publish directory is over ${Math.round(maxBytes / 1048576)} MB.`);
              child.kill('SIGTERM');
              return;
            }
            hash.update(data);
            let rest = data;
            while (rest.length) {
              const room = chunkBytes - pendingBytes;
              pending.push(rest.subarray(0, room));
              pendingBytes += Math.min(room, rest.length);
              rest = rest.subarray(room);
              if (pendingBytes >= chunkBytes) flush();
            }
          });
          child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
          child.on('error', reject);
          child.on('close', (code) => {
            if (failed) return reject(failed);
            if (code !== 0) {
              const why = errorLine(stderr);
              return reject(new Error(/could not find|no such file/i.test(why) ? `There is no ${dir} folder after the build: check that the build command writes the site there.` : (why || 'docker cp failed').slice(0, 500)));
            }
            flush();
            return resolve({ bytes, sha256: hash.digest('hex') });
          });
        });
      } finally {
        await exec(docker, ['rm', '--force', '--', name]).catch(() => {});
      }
    },

    async run(a) {
      const envFile = await writeEnv(a.name, a.env);
      try {
        await must(docker, runArgs(a, { envFile }));
      } finally {
        if (envFile) await fs.rm(envFile, { force: true });
      }
      return { name: a.name, state: 'running', hostPort: a.hostPort ?? null };
    },

    inspect,

    async stop(name, timeoutS = 10) {
      await must(docker, ['stop', '--time', String(timeoutS), '--', name]);
      return { name, state: 'exited' };
    },

    async remove(name) {
      await must(docker, ['rm', '--force', '--', name]);
      return { name, removed: true };
    },

    async list(labels) {
      const args = ['ps', '--all', '--no-trunc', '--format', '{{json .}}'];
      for (const [k, v] of Object.entries(labels)) args.push('--filter', `label=${k}=${v}`);
      const r = await must(docker, args);
      return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => ({
        name: c.Names, labels: parseLabels(c.Labels), state: c.State, image: c.Image, status: c.Status,
      }));
    },

    /** Asks the app on its published port until it answers below 500, the container stops, or time runs out. */
    async health(name, port, urlPath, timeoutS = 5) {
      const end = Date.now() + timeoutS * 1000;
      let last = { ok: false, status: 0, path: urlPath, message: 'No answer yet.' };
      while (Date.now() < end) {
        const c = await inspect(name);
        if (!c) return { ok: false, status: 0, path: urlPath, message: 'The container is gone.' };
        if (c.state === 'exited' || c.state === 'dead') {
          const tail = await exec(docker, ['logs', '--tail', '20', '--', name]);
          return { ok: false, status: 0, path: urlPath, exited: true, exitCode: c.exitCode, message: `The app stopped with exit code ${c.exitCode}.`, tail: `${tail.stdout}${tail.stderr}`.slice(-4000) };
        }
        const bound = c.ports?.[`${port}/tcp`]?.[0];
        if (bound) {
          try {
            const res = await fetch(`http://${bound.HostIp === '0.0.0.0' ? '127.0.0.1' : bound.HostIp}:${bound.HostPort}${urlPath}`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
            await res.body?.cancel();
            last = { ok: res.status < 500, status: res.status, path: urlPath };
            if (last.ok) return last;
          } catch (err) {
            last = { ok: false, status: 0, path: urlPath, message: `Not answering on port ${port} yet.` };
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return last;
    },

    /** A job (8.2 R6): runs to completion and is removed; its memory is sampled every 2 s for the peak. */
    async job(a, onLine) {
      const envFile = await writeEnv(a.name, a.env);
      const started = Date.now();
      let peak = 0;
      const sample = async () => {
        const r = await exec(docker, ['stats', '--no-stream', '--format', '{{.MemUsage}}', '--', a.name]).catch(() => null);
        if (r?.code === 0) peak = Math.max(peak, toMb(String(r.stdout).split('/')[0]));
      };
      const timer = setInterval(() => { sample(); }, 2000);
      timer.unref?.();
      // A first sample soon after the start, so a short job has a peak too.
      const first = setTimeout(() => { sample(); }, 500);
      first.unref?.();
      try {
        const r = await exec(docker, runArgs(a, { envFile, detach: false }), { onLine, keep: false });
        return { exitCode: r.code, durationMs: Date.now() - started, peakMemoryMb: Math.round(peak) || null };
      } finally {
        clearInterval(timer);
        clearTimeout(first);
        if (envFile) await fs.rm(envFile, { force: true });
      }
    },

    /** Follows a container's output with timestamps. Returns stop(). */
    async logs(name, { since }, onLine, onEnd) {
      const args = ['logs', '--follow', '--timestamps'];
      if (since) args.push('--since', since);
      const child = spawn(docker, [...args, '--', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const out of ['stdout', 'stderr']) {
        createInterface({ input: child[out] }).on('line', (raw) => {
          const i = raw.indexOf(' ');
          const at = i > 0 && /^\d{4}-\d\d-\d\dT/.test(raw) ? raw.slice(0, i) : new Date().toISOString();
          onLine(out, i > 0 && at === raw.slice(0, i) ? raw.slice(i + 1) : raw, at);
        });
      }
      let ended = false;
      child.on('close', () => { if (!ended) { ended = true; onEnd(); } });
      child.on('error', () => { if (!ended) { ended = true; onEnd(); } });
      return () => {
        ended = true;
        child.kill();
      };
    },

    /**
     * Every container of these labels: its state, the exit code of its last run and how many times Docker restarted
     * it (8.2 R7). A container Docker restarted and that runs again says exit code 0; the code of the run that ended
     * is in its `die` event, read once per restart.
     */
    async states(labels) {
      const names = (await this.list(labels)).map((c) => c.name);
      if (!names.length) return [];
      const r = await exec(docker, ['inspect', '--type', 'container', '--format', '{{json .}}', '--', ...names]);
      const rows = String(r.stdout).split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return Promise.all(rows.map(async (c) => {
        const restarts = c.RestartCount ?? 0;
        let exitCode = c.State?.ExitCode ?? null;
        if (restarts > 0 && c.State?.Status === 'running') exitCode = await diedWith(c, restarts);
        return { name: c.Name.replace(/^\//, ''), state: c.State?.Status ?? 'unknown', exitCode, restarts };
      }));
    },

    async stats(labels) {
      const mine = (await this.list(labels)).filter((c) => c.state === 'running');
      if (!mine.length) return [];
      const r = await must(docker, ['stats', '--no-stream', '--format', '{{json .}}', '--', ...mine.map((c) => c.name)]);
      return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((s) => {
        const [used, limit] = String(s.MemUsage).split('/');
        const [rx, tx] = String(s.NetIO ?? '').split('/');
        return {
          name: s.Name, cpu: Math.round((Number.parseFloat(s.CPUPerc) || 0) / 100 * 1000) / 1000, memoryMb: toMb(used), memoryLimitMb: toMb(limit),
          rxBytes: toBytes(rx), txBytes: toBytes(tx), pids: Number(s.PIDs) || 0,
        };
      });
    },
  };
}

/** This server's facts (R4). */
export async function serverFacts({ docker = 'docker' } = {}) {
  const osRelease = await fs.readFile('/etc/os-release', 'utf8').catch(() => '');
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease)?.[1] ?? `${os.type()} ${os.release()}`;
  const disk = await fs.statfs('/').catch(() => null);
  const info = await exec(docker, ['info', '--format', '{{json .}}']).catch(() => ({ code: 1 }));
  let d = {};
  if (info.code === 0) {
    try {
      d = JSON.parse(info.stdout);
    } catch { /* leave empty */ }
  }
  const sec = (d.SecurityOptions ?? []).join(' ');
  const addresses = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  return {
    hostname: os.hostname(),
    os: pretty,
    kernel: os.release(),
    cpus: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1048576),
    diskFreeGb: disk ? Math.round((disk.bavail * disk.bsize) / 1e9) : null,
    docker: d.ServerVersion ?? null,
    cgroup: Number(d.CgroupVersion) || null,
    security: { userns: /userns/.test(sec), rootless: /rootless/.test(sec), apparmor: /apparmor/.test(sec), seccomp: /seccomp/.test(sec) },
    systemd: await fs.readFile('/proc/1/comm', 'utf8').then((s) => s.trim() === 'systemd').catch(() => false),
    addresses,
  };
}
