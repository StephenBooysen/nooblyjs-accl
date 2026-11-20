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

/** The base images of the runtime templates (8.3.1's pinned bases, by tag for now). */
export const BASES = { node22: 'node:22-bookworm-slim', python312: 'python:3.12-slim-bookworm', go123: 'golang:1.23-bookworm' };

/** A one-line shell command for a Dockerfile's RUN or CMD (protocol.js refuses newlines; this is the second check). */
const oneLine = (s) => {
  if (/[\r\n]/.test(s)) throw new Error('A build or start command is one line.');
  return s;
};

/** The Dockerfile for a runtime template (R8). The app runs as an unprivileged user with HOME=/tmp. */
export function dockerfileFor(runtime, { buildCommand, startCommand } = {}) {
  const build = buildCommand ? oneLine(buildCommand) : null;
  const start = startCommand ? oneLine(startCommand) : null;
  const json = (cmd) => JSON.stringify(['/bin/sh', '-c', cmd]);
  if (runtime === 'node22') {
    return [
      `FROM ${BASES.node22}`,
      'WORKDIR /app',
      'COPY --chown=node:node . .',
      `RUN ${json(build ?? 'if [ -f package-lock.json ]; then npm ci; else npm install; fi')}`,
      'ENV HOME=/tmp NPM_CONFIG_UPDATE_NOTIFIER=false',
      'USER node',
      `CMD ${json(start ?? 'npm start')}`,
      '',
    ].join('\n');
  }
  if (runtime === 'python312') {
    return [
      `FROM ${BASES.python312}`,
      'WORKDIR /app',
      'COPY . .',
      `RUN ${json(build ?? 'if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi')}`,
      'ENV HOME=/tmp PYTHONUNBUFFERED=1',
      'USER nobody',
      `CMD ${json(start ?? 'python app.py')}`,
      '',
    ].join('\n');
  }
  if (runtime === 'go123') {
    return [
      `FROM ${BASES.go123}`,
      'WORKDIR /app',
      'COPY . .',
      `RUN ${json(build ?? 'go build -o /app/server .')}`,
      'ENV HOME=/tmp',
      'USER nobody',
      `CMD ${json(start ?? '/app/server')}`,
      '',
    ].join('\n');
  }
  throw new Error(`No template for ${runtime}.`);
}

/** The `docker run` arguments for container.run / job.run (R6). Exported so tests can check every flag. */
export function runArgs(a, { envFile = null, detach = true } = {}) {
  const args = ['run', detach ? '-d' : '--rm', '--name', a.name];
  for (const [k, v] of Object.entries(a.labels)) args.push('--label', `${k}=${v}`);
  if (a.network) args.push('--network', a.network);
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
export function exec(cmd, args, { cwd, env, input, onLine, keep = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

async function must(cmd, args, o) {
  const r = await exec(cmd, args, o);
  if (r.code !== 0) throw new Error((r.stderr.trim().split('\n').at(-1) || `${cmd} ${args[0]} failed`).slice(0, 500));
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
export function createDocker({ stateDir, docker = 'docker', git = 'git' }) {
  const envDir = path.join(stateDir, 'env');

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
        if (a.runtime === 'dockerfile') {
          onLine('Building from the repository\'s Dockerfile');
        } else {
          const file = path.join(work, 'Dockerfile.noobly');
          await fs.writeFile(file, dockerfileFor(a.runtime, a));
          args.push('-f', file);
          onLine(`Building with the ${a.runtime} template (${BASES[a.runtime]})`);
        }
        const built = await exec(docker, [...args, '--', context], { onLine: (_, l) => onLine(l), keep: false, env: { DOCKER_BUILDKIT: '1' } });
        if (built.code !== 0) throw new Error('The image build failed; the lines above say why.');
        onLine(`Built ${a.tag}`);
        return { tag: a.tag, commit };
      } finally {
        await fs.rm(work, { recursive: true, force: true });
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

    async job(a, onLine) {
      const envFile = await writeEnv(a.name, a.env);
      const started = Date.now();
      try {
        const r = await exec(docker, runArgs(a, { envFile, detach: false }), { onLine, keep: false });
        return { exitCode: r.code, durationMs: Date.now() - started };
      } finally {
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
