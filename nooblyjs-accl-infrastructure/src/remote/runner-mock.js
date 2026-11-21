// The mock runner: what a VM on the mock cloud answers when Noobly Cloud runs a script on it. First boot takes two
// units of mock cloud time after the VM is running; health comes from the VM's `sim` figures (the seed story sets them
// from the mockups) or from steady defaults.
//
// Caddy (roadmap phase 3) is kept on the mock VM's resource as `caddy: { sites, certs, issued }`: site files by address,
// uploaded certificates by endpoint, and the certificates Caddy "obtained". A Let's Encrypt certificate is obtained
// only once the mock DNS points the address at the VM, as the real HTTP-01 challenge needs. Files sent with put() wait
// in `staged` until a script takes them. `caddyRefuses: '<reason>'` on the resource makes the next site file fail
// Caddy's check, for the tests.
//
// Apps (roadmap phase 6) are kept as `apps: { <app>: { sources, images, env, containers } }`. A clone asks the mock Git
// host what the branch holds (a private repository needs the token sent before it); a commit starting bad0 fails its
// build and one starting dead builds an image whose health check fails (the mock host's `broken-build` and `unhealthy`
// branches). `containerExits: '<app>'` on the resource stops that app's running container, as a crash would.

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('aborted'));
  }, { once: true });
});

const GB = 1e9;
const DAY = 86_400_000;

/**
 * @param {object} o
 * @param {object} o.cloud     the account's MockCloud
 * @param {string} o.ref       the VM's id in it
 * @param {object} [o.catalog]
 * @param {{ lookup(host: string): Promise<string[]> }} [o.dns]   the mock DNS
 * @param {{ clone(url, branch, o): object }} [o.git]   the mock Git host
 */
export function createMockRunner({ cloud, ref, catalog, dns = { lookup: async () => [] }, git = null }) {
  const vm = async () => (await cloud.resources((r) => r.id === ref && r.kind === 'vm'))[0] ?? null;
  const ok = (value) => ({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
  const no = (code, message) => ({ code, stdout: `${JSON.stringify({ ok: false, message })}\n`, stderr: message });
  const iso = (ms) => new Date(ms).toISOString();
  const caddyOf = (machine) => ({ sites: {}, certs: {}, issued: {}, ...(machine.caddy ?? {}) });

  /** Changes the mock VM's Caddy and staged files under the cloud's lock. */
  const change = (fn) => cloud.mutate((state) => {
    const machine = state.resources.find((r) => r.id === ref && r.kind === 'vm');
    machine.caddy = caddyOf(machine);
    machine.staged ??= {};
    return fn(machine);
  });

  /** The app scripts (src/remote/scripts/app-*.sh) on the mock VM's `apps`. */
  async function appScript(script, args, { onLine }) {
    const appOf = (m, app) => {
      m.apps ??= {};
      m.apps[app] ??= { sources: {}, images: [], env: null, containers: [] };
      return m.apps[app];
    };
    const shaOf = (tag) => String(tag).split(':').pop();
    if (script === 'app-clone') {
      const [app, repo, branch, deploy, tokenName] = args;
      return change((m) => {
        let token = null;
        if (tokenName !== '-') {
          token = m.staged[tokenName];
          delete m.staged[tokenName];
          if (token === undefined) return no(2, 'The token did not arrive.');
        }
        const found = git?.clone(repo, branch, { token }) ?? { sha: 'f00dfeed'.padEnd(40, '0'), message: `Latest on ${branch}` };
        if (found.error) return no(3, `git clone failed: ${found.error}`);
        appOf(m, app).sources[deploy] = { commit: found.sha, dockerfile: found.dockerfile ?? 'FROM scratch\n' };
        m.clones = [...(m.clones ?? []), { app, repo, branch, withToken: Boolean(token) }];
        return ok({ ok: true, commit: found.sha, message: found.message });
      });
    }
    if (script === 'app-build') {
      const [app, deploy, dockerfile, , tag] = args;
      const source = (await vm())?.apps?.[app]?.sources?.[deploy];
      if (!source) return no(2, 'The source is not there: clone it first.');
      const lines = [`#0 building with "default" instance using docker driver`, `#1 [internal] load build definition from ${dockerfile.replace(/^\.\//, '')}`,
        ...source.dockerfile.split('\n').filter((l) => /^(FROM|RUN|COPY)\b/.test(l)).map((l, i) => `#${i + 2} [${i + 1}] ${l}`)];
      const failed = shaOf(tag).startsWith('bad0');
      if (failed) lines.push('#5 ERROR: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1');
      else lines.push(`#9 exporting to image`, `#9 naming to docker.io/${tag} done`);
      for (const l of lines) onLine?.(l);
      return change((m) => {
        delete appOf(m, app).sources[deploy];
        if (failed) return { code: 4, stdout: `${lines.join('\n')}\n{"ok":false,"message":"The build failed (docker build exited with 1). The log above says where."}\n`, stderr: '' };
        const a = appOf(m, app);
        a.images = [tag, ...a.images.filter((t) => t !== tag)];
        return { code: 0, stdout: `${lines.join('\n')}\n{"ok":true,"image":"${tag}"}\n`, stderr: '' };
      });
    }
    if (script === 'app-env') {
      const [app, staged] = args;
      return change((m) => {
        if (m.staged[staged] === undefined) return no(2, 'The environment did not arrive.');
        appOf(m, app).env = m.staged[staged];
        delete m.staged[staged];
        return ok({ ok: true });
      });
    }
    if (script === 'app-run') {
      const [app, tag, name, cport, restart] = args;
      return change((m) => {
        const a = appOf(m, app);
        if (!a.images.includes(tag)) return no(4, `The container did not start: Unable to find image '${tag}' locally`);
        if (a.env === null) return no(2, 'The environment file is missing.');
        const used = new Set(Object.values(m.apps).flatMap((x) => x.containers.map((c) => c.port)));
        let port = null;
        if (cport !== '-') for (port = 30000; used.has(port); port += 1);
        a.containers = [...a.containers.filter((c) => c.name !== name), { name, image: tag, port, containerPort: cport === '-' ? null : Number(cport), restart, state: 'running', restarts: 0, healthy: !shaOf(tag).startsWith('dead'), env: a.env }];
        return ok({ ok: true, container: name, port });
      });
    }
    if (script === 'app-health') {
      const [name, port, path, limit] = args;
      const c = Object.values((await vm())?.apps ?? {}).flatMap((a) => a.containers).find((x) => x.name === name);
      if (!c || c.state !== 'running') return { code: 4, stdout: `${JSON.stringify({ ok: false, status: null, message: 'The container stopped: Error: Cannot find module' })}\n`, stderr: '' };
      if (!c.healthy) return { code: 4, stdout: `${JSON.stringify({ ok: false, status: 500, message: `GET ${path} did not answer 200 within ${limit} seconds` })}\n`, stderr: '' };
      return ok({ ok: true, status: port === '-' ? null : 200, seconds: 1 });
    }
    if (script === 'app-containers') {
      const [action, app, arg, lines] = args;
      return change((m) => {
        const a = appOf(m, app);
        const find = () => a.containers.find((c) => c.name === arg);
        if (action === 'remove') {
          a.containers = a.containers.filter((c) => c.name !== arg);
          return ok({ ok: true });
        }
        if (action === 'stop' || action === 'start') {
          const c = find();
          if (!c) return no(2, `No container ${arg} of ${app}.`);
          c.state = action === 'stop' ? 'exited' : 'running';
          return ok({ ok: true });
        }
        if (action === 'retire') {
          const stopped = a.containers.filter((c) => c.name !== arg).map((c) => c.name);
          a.containers = a.containers.filter((c) => c.name === arg);
          return ok({ ok: true, stopped });
        }
        if (action === 'state') {
          if (m.containerExits === app) {
            for (const c of a.containers) if (c.state === 'running') Object.assign(c, { state: 'exited', exitCode: 1, restarts: (c.restarts ?? 0) + 3 });
            delete m.containerExits;
          }
          return ok({ ok: true, containers: a.containers.map((c) => ({ name: c.name, state: c.state, restarts: c.restarts ?? 0, exitCode: c.exitCode ?? 0 })) });
        }
        if (action === 'logs') {
          const c = find();
          if (!c) return no(2, `No container ${arg} of ${app}.`);
          const n = Math.min(Number(lines) || 200, 5);
          const at = new Date(cloud.now()).toISOString();
          return { code: 0, stdout: Array.from({ length: n }, (_, i) => `${at} ${app} ${['listening on port', 'GET /healthz 200', 'GET / 200', 'GET /api/items 200', 'GET /healthz 200'][i % 5]}${i === 0 ? ` ${c.containerPort ?? ''}` : ''}`).join('\n') + '\n', stderr: '' };
        }
        if (action === 'prune') {
          const inUse = new Set(a.containers.map((c) => c.image));
          const keep = Number(arg);
          const drop = a.images.slice(keep).filter((t) => !inUse.has(t));
          a.images = a.images.filter((t) => !drop.includes(t));
          return ok({ ok: true, removed: drop.length });
        }
        if (action === 'delete') {
          delete m.apps[app];
          return ok({ ok: true });
        }
        return no(2, 'Not an action.');
      });
    }
    return { code: 127, stdout: '', stderr: `bash: ${script}: no such script on the mock cloud` };
  }

  return {
    async run(script, args = [], { signal, onLine } = {}) {
      const machine = await vm();
      if (!machine || machine.status !== 'running') return { code: 255, stdout: '', stderr: 'ssh: connect to host: Connection refused' };
      if (script === 'wait-ready') {
        if (!machine.ready) {
          await sleep(2 * cloud.stepMs, signal);
          await cloud.outOfBand(ref, { ready: true, docker: /docker/.test(machine.userData ?? '') ? '27.3.1' : '', caddy: /"caddy"|copr/.test(machine.userData ?? '') ? caddyOf({}) : null });
        }
        const after = await vm();
        return ok({ ready: true, docker: after.docker ?? '' });
      }
      if (script === 'health') {
        const type = catalog?.machineTypes?.[machine.machineType];
        const sim = machine.sim ?? {};
        const memTotal = (type?.memoryGb ?? 4) * GB;
        const diskTotal = (machine.diskGb ?? 30) * GB;
        return ok({
          memory: { totalBytes: memTotal, usedBytes: Math.round((sim.memUsedGb ?? (type?.memoryGb ?? 4) * 0.4) * GB) },
          disk: { totalBytes: diskTotal, usedBytes: Math.round((sim.diskUsedGb ?? (machine.diskGb ?? 30) * 0.25) * GB) },
          uptimeSeconds: Math.max(0, Math.round((cloud.now() - new Date(machine.startedAt ?? machine.createdAt).getTime()) / 1000)),
        });
      }
      if (script === 'caddy-site') {
        const [host, staged] = args;
        return change((m) => {
          const text = m.staged[staged];
          if (text === undefined) return no(2, 'The site file did not arrive.');
          delete m.staged[staged];
          if (m.caddyRefuses) {
            const reason = m.caddyRefuses;
            delete m.caddyRefuses;
            return no(4, `Caddy refused it: ${reason}`);
          }
          m.caddy.sites[host] = text;
          return ok({ ok: true });
        });
      }
      if (script === 'caddy-remove') {
        const [host] = args;
        return change((m) => {
          delete m.caddy.sites[host];
          delete m.caddy.issued[host];
          return ok({ ok: true });
        });
      }
      if (script === 'caddy-cert') {
        const [id, certFile, keyFile] = args;
        return change((m) => {
          if (m.staged[certFile] === undefined || m.staged[keyFile] === undefined) return no(2, 'The certificate did not arrive.');
          m.caddy.certs[id] = { cert: m.staged[certFile], keyBytes: m.staged[keyFile].length };
          delete m.staged[certFile];
          delete m.staged[keyFile];
          return ok({ ok: true });
        });
      }
      if (script === 'caddy-certs') {
        const now = cloud.now();
        const certs = [];
        const issued = { ...caddyOf(machine).issued };
        for (const [host, text] of Object.entries(caddyOf(machine).sites)) {
          if (/\btls internal\b/.test(text)) certs.push({ host, issuer: 'local', expiresAt: iso(now + 7 * DAY) });
          else if (/\btls \/etc\/caddy\/certs\//.test(text)) continue; // uploaded: not in Caddy's storage
          else if ((await dns.lookup(host)).includes(machine.publicIp)) {
            issued[host] ??= { issuer: 'acme', expiresAt: iso(now + 90 * DAY) };
            certs.push({ host, ...issued[host] });
          }
        }
        if (JSON.stringify(issued) !== JSON.stringify(caddyOf(machine).issued)) await change((m) => { m.caddy.issued = issued; });
        return ok({ certs });
      }
      if (script === 'caddy-requests') {
        const sim = machine.sim?.requests ?? {};
        const hosts = new Set([...Object.keys(caddyOf(machine).sites), ...Object.keys(sim)]);
        return ok({ hosts: [...hosts].map((host) => ({ host, total: sim[host]?.total ?? 0, ok: sim[host]?.ok ?? 0 })) });
      }
      if (script.startsWith('app-')) return appScript(script, args, { onLine });
      return { code: 127, stdout: '', stderr: `bash: ${script}: no such script on the mock cloud` };
    },
    /** As the SSH runner: a file waits in ~/.noobly/<name> for a script. */
    async put(name, content) {
      const machine = await vm();
      if (!machine || machine.status !== 'running') throw new Error('ssh: connect to host: Connection refused');
      await change((m) => { m.staged[name] = String(content); });
    },
    close() {},
  };
}
