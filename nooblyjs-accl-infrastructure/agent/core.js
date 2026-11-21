// The agent's session with the controller (spec 8.9 R2–R6, R11). Transport-agnostic: `transport` is anything with
// send(text), onMessage(fn), onClose(fn) and close() — the WebSocket in production (8.9.2), an in-memory link in tests.
// Docker-agnostic: `docker` is the Docker Engine API over the socket (docker.js, 8.9.5) or the in-memory fake
// (docker-mock.js).
//
// The agent trusts nothing it is sent: every frame is checked with protocol.js again before it acts, it only touches
// what carries its install's label, and it runs file:// sources only in --dev mode.
import crypto from 'node:crypto';
import { encode, decode, ProtocolError, AGENT_VERSION, cutLine, maskLine } from './protocol.js';

const LOG_FLUSH_MS = 200;
const LOG_BATCH = 200;

export class CommandError extends Error {
  /** @param {string} code  'refused' | 'not_found' | 'docker' | 'invalid' */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Starts a session: sends `hello` (enrolled) or `enrol` (first time) and answers the controller until the transport
 * closes.
 * @param {object} o
 * @param {{ send(text: string): void, onMessage(fn: (text: string) => void): void, onClose(fn: () => void): void, close(): void }} o.transport
 * @param {object} o.docker
 * @param {{ server?: string, credential?: string, token?: string }} o.identity
 * @param {() => Promise<object>} [o.facts]
 * @param {boolean} [o.dev]                 allow file:// sources (tests, a development machine)
 * @param {(w: { server: string, credential?: string, install: string }) => Promise<void>|void} [o.onWelcome]  keeps the credential
 * @param {(reason: string, o: { retry: boolean, type: string }) => void} [o.onRefused]
 * @param {(err: Error) => void} [o.onError]
 * @returns {{ closed: Promise<void>, stop(): void, state(): object }}
 */
export function startSession({ transport, docker, identity, facts = async () => ({}), dev = false, onWelcome, onRefused, onError = () => {} }) {
  let install = null;
  let welcomed = false;
  let heartbeat = null;
  const streams = new Map(); // stream id → { stop() }
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  const send = (frame) => {
    try {
      transport.send(encode(frame));
    } catch (err) {
      onError(err);
    }
  };

  function stopAll() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const s of streams.values()) {
      try {
        s.stop();
      } catch { /* already stopped */ }
    }
    streams.clear();
  }

  /** A log stream: lines are batched every LOG_FLUSH_MS (8.5 R3: in the launcher within 3 s). */
  function logStream(stream, { mask = [] } = {}) {
    let seq = 0;
    let pending = [];
    let timer = null;
    const flush = () => {
      timer = null;
      while (pending.length) send({ type: 'log', stream, seq: seq++, lines: pending.splice(0, LOG_BATCH) });
    };
    return {
      push(out, line, at = new Date().toISOString()) {
        pending.push({ out, at, line: cutLine(maskLine(line, mask)) });
        if (pending.length >= LOG_BATCH) flush();
        else if (!timer) timer = setTimeout(flush, LOG_FLUSH_MS);
      },
      end() {
        if (timer) clearTimeout(timer);
        flush();
        send({ type: 'stream-end', stream });
      },
    };
  }

  /** Commands that name a container: it must exist and be this install's. */
  async function ours(name) {
    const c = await docker.inspect(name);
    if (!c) throw new CommandError('not_found', `No container ${name}.`);
    if (c.labels?.['noobly-install'] !== install) throw new CommandError('refused', `${name} does not belong to this install.`);
    return c;
  }
  const ownLabels = (labels) => {
    if (labels?.['noobly-install'] !== install) throw new CommandError('refused', 'The labels name another install.');
  };

  const run = {
    'facts.get': async () => facts(),
    'network.ensure': async (a) => {
      ownLabels(a.labels);
      return docker.ensureNetwork(a.name, a.labels);
    },
    'image.build': async (a) => {
      ownLabels(a.labels);
      if (a.source.repo.startsWith('file:') && !dev) throw new CommandError('refused', 'file:// sources run only on an agent started with --dev.');
      const out = logStream(a.stream, { mask: [...(a.mask ?? []), ...(a.gitToken ? [a.gitToken] : []), ...(a.buildEnv ?? []).map((e) => e.value)] });
      try {
        return await docker.build(a, (line) => out.push('build', line));
      } finally {
        out.end();
      }
    },
    'image.push': async (a) => {
      const out = logStream(a.stream, { mask: [a.auth.password] });
      try {
        return await docker.push(a, (line) => out.push('build', line));
      } finally {
        out.end();
      }
    },
    'image.pull': async (a) => {
      const out = logStream(a.stream, { mask: a.auth ? [a.auth.password] : [] });
      try {
        return await docker.pull(a, (line) => out.push('build', line));
      } finally {
        out.end();
      }
    },
    'image.remove': async (a) => docker.removeImage(a.tag),
    'ingress.sync': async (a) => docker.ingressSync(a),
    'ingress.counters': async () => ({ hosts: await docker.ingressCounters() }),
    'container.run': async (a) => {
      ownLabels(a.labels);
      if (await docker.inspect(a.name)) throw new CommandError('refused', `${a.name} exists already.`);
      return docker.run(a);
    },
    'container.stop': async (a) => {
      await ours(a.name);
      return docker.stop(a.name, a.timeoutS ?? 10);
    },
    'container.remove': async (a) => {
      await ours(a.name);
      for (const [id, s] of streams) if (s.container === a.name) { s.stop(); streams.delete(id); }
      return docker.remove(a.name);
    },
    'container.list': async (a) => {
      ownLabels(a.labels);
      return { containers: await docker.list(a.labels) };
    },
    'health.check': async (a) => {
      await ours(a.name);
      return docker.health(a.name, a.port, a.path, a.timeoutS ?? 5);
    },
    'job.run': async (a) => {
      ownLabels(a.labels);
      const out = logStream(a.stream);
      try {
        return await docker.job(a, (o, line) => out.push(o, line));
      } finally {
        out.end();
      }
    },
    'logs.follow': async (a) => {
      await ours(a.name);
      if (streams.has(a.stream)) throw new CommandError('refused', `Stream ${a.stream} is open already.`);
      const out = logStream(a.stream);
      const stop = await docker.logs(a.name, { since: a.since ?? null }, (o, line, at) => out.push(o, line, at), () => {
        streams.delete(a.stream);
        out.end();
      });
      streams.set(a.stream, { container: a.name, stop: () => { stop(); out.end(); } });
      return { stream: a.stream };
    },
    'logs.stop': async (a) => {
      const s = streams.get(a.stream);
      if (!s) throw new CommandError('not_found', `No stream ${a.stream}.`);
      streams.delete(a.stream);
      s.stop();
      return { stream: a.stream };
    },
    'stats.watch': async (a) => {
      ownLabels(a.labels);
      if (streams.has(a.stream)) throw new CommandError('refused', `Stream ${a.stream} is open already.`);
      let seq = 0;
      const tick = async () => {
        try {
          // Samples of the running containers, and every container's state and restart count (crashes, spec 8.2 R7).
          send({ type: 'stats', stream: a.stream, seq: seq++, at: new Date().toISOString(), samples: await docker.stats(a.labels), containers: await docker.states(a.labels) });
        } catch (err) {
          onError(err);
        }
      };
      const timer = setInterval(tick, (a.intervalS ?? 10) * 1000);
      timer.unref?.();
      tick();
      streams.set(a.stream, { stop: () => clearInterval(timer) });
      return { stream: a.stream };
    },
  };

  async function onCommand(frame) {
    try {
      const data = await run[frame.name](frame.args ?? {});
      send({ type: 'result', id: frame.id, data: data ?? {} });
    } catch (err) {
      const code = err instanceof CommandError ? err.code : 'docker';
      send({ type: 'error', id: frame.id, code, message: String(err.message ?? err).slice(0, 1000) });
    }
  }

  transport.onMessage(async (text) => {
    let frame;
    try {
      frame = decode(text, 'controller');
    } catch (err) {
      // A frame we cannot read: say so (with the request's id when it has one) and carry on.
      let id = 'protocol';
      try {
        const raw = JSON.parse(text);
        if (typeof raw?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) id = raw.id;
      } catch { /* not JSON */ }
      send({ type: 'error', id, code: err instanceof ProtocolError ? err.code : 'invalid', message: err.message, problems: err.problems?.slice(0, 20) });
      return;
    }
    if (frame.type === 'welcome') {
      welcomed = true;
      install = frame.install;
      await onWelcome?.({ server: frame.server, credential: frame.credential, install: frame.install });
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), frame.heartbeatMs);
      heartbeat.unref?.();
      return;
    }
    if (frame.type === 'refused' || frame.type === 'bye') {
      onRefused?.(frame.reason, { retry: frame.retry === true, type: frame.type });
      transport.close();
      return;
    }
    if (frame.type === 'command') {
      if (!welcomed) return send({ type: 'error', id: frame.id, code: 'refused', message: 'Not welcomed yet.' });
      await onCommand(frame);
    }
  });

  transport.onClose(() => {
    stopAll();
    resolveClosed();
  });

  // The first frame (R3): hello when enrolled, enrol with the one-time token otherwise.
  facts().then((f) => {
    if (identity.server && identity.credential) send({ type: 'hello', server: identity.server, credential: identity.credential, agentVersion: AGENT_VERSION, facts: f });
    else if (identity.token) send({ type: 'enrol', token: identity.token, agentVersion: AGENT_VERSION, facts: f });
    else throw new Error('The agent has neither a credential nor an enrolment token.');
  }).catch((err) => {
    onError(err);
    transport.close();
  });

  return {
    closed,
    stop() {
      stopAll();
      transport.close();
    },
    state: () => ({ welcomed, install, streams: [...streams.keys()] }),
  };
}

/** A new random credential in the protocol's form (43 base64url characters = 32 bytes). */
export const newCredential = () => crypto.randomBytes(32).toString('base64url');
