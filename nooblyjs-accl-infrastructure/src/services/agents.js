// The controller's end of the agent channel (spec 8.9 R3, R12, "Controller"). One session per enrolled server:
// the first frame is hello or enrol, checked by `verify` (the server records, 8.9.3); then heartbeats keep it online,
// commands go out and are answered by id, and log/stats frames are handed to `onStream`. A server silent for
// OFFLINE_AFTER_MS is offline and its connection is closed; the agent reconnects with backoff.
//
// Transport-agnostic like the agent: attach() takes { send, onMessage, onClose, close } (an in-memory link in tests),
// and upgradeHandler() turns a WebSocket upgrade into one, with `ws` (frames over 1 MB are refused by the socket too).
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import {
  encode, decode, checkCommand, ProtocolError, MAX_FRAME_BYTES, HEARTBEAT_MS, OFFLINE_AFTER_MS, AGENT_VERSION,
} from '../../agent/protocol.js';

export class AgentError extends Error {
  /** @param {string} code  'offline' | 'timeout' | 'invalid' | agent error codes ('refused', 'not_found', 'docker', …) */
  constructor(code, message, problems) {
    super(message);
    this.code = code;
    if (problems) this.problems = problems;
  }
}

/** Loopback or a private (RFC 1918, unique-local IPv6) address: where plain ws:// is allowed (R3, LAN mode). */
export function isPrivateAddress(address) {
  if (typeof address !== 'string') return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
  }
  if (net.isIPv6(a)) return a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a);
  return a === 'localhost';
}

/**
 * @param {object} o
 * @param {(frame: object, ctx: { address: string }) => Promise<{ server: string, install: string, credential?: string }>} o.verify
 *   accepts a hello or enrol frame (resolves with who it is) or refuses it (throws; its message is sent to the agent)
 * @param {(server: string, status: 'online'|'offline', session?: object) => void} [o.onStatus]
 * @param {(server: string, facts: object) => void} [o.onFacts]
 * @param {(server: string, frame: object) => void} [o.onStream]   log, stats and stream-end frames
 * @param {() => number} [o.now]
 * @param {{ warn: Function, info: Function }} [o.log]
 * @param {number} [o.heartbeatMs]
 * @param {number} [o.offlineAfterMs]
 * @param {number} [o.checkMs]          how often to look for silent servers (0: never; tests call check())
 * @param {number} [o.helloTimeoutMs]   time allowed for the first frame
 * @param {number} [o.commandTimeoutMs]
 * @param {number} [o.connectsPerMinute]  per address (R12)
 */
export function createAgentHub({
  verify, onStatus = () => {}, onFacts = () => {}, onStream = () => {}, now = () => Date.now(), log = { warn() {}, info() {} },
  heartbeatMs = HEARTBEAT_MS, offlineAfterMs = OFFLINE_AFTER_MS, checkMs = 5000, helloTimeoutMs = 10_000,
  commandTimeoutMs = 60_000, connectsPerMinute = 20,
}) {
  if (typeof verify !== 'function') throw new Error('createAgentHub needs verify(frame).');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs > 120_000) throw new Error('heartbeatMs is from 1000 to 120000 (the protocol\'s welcome frame).');
  const sessions = new Map(); // server → session
  const attempts = new Map(); // address → [times]
  let closed = false;
  let wss = null;

  function drop(session, { reason, retry = false, status = 'offline' } = {}) {
    if (session.dropped) return;
    session.dropped = true;
    if (reason) {
      try {
        session.transport.send(encode({ type: 'bye', reason, retry }));
      } catch { /* the link is gone */ }
    }
    try {
      session.transport.close();
    } catch { /* already closed */ }
    for (const p of session.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentError('offline', `${session.server} disconnected.`));
    }
    session.pending.clear();
    if (sessions.get(session.server) === session) {
      sessions.delete(session.server);
      onStatus(session.server, status, view(session));
    }
  }

  const view = (s) => ({ server: s.server, install: s.install, address: s.address, agentVersion: s.agentVersion, connectedAt: new Date(s.connectedAt).toISOString(), lastSeenAt: new Date(s.lastSeenAt).toISOString(), outdated: s.agentVersion !== AGENT_VERSION });

  /**
   * Takes over a new connection. Returns once it is set up; the session lives until the transport closes.
   * @param {{ send(text: string): void, onMessage(fn): void, onClose(fn): void, close(): void }} transport
   * @param {{ address?: string }} [ctx]
   */
  function attach(transport, { address = 'unknown' } = {}) {
    if (closed) return transport.close();
    let session = null;
    let first = true;
    const refuse = (reason, retry = false) => {
      try {
        transport.send(encode({ type: 'refused', reason, retry }));
      } catch { /* gone */ }
      transport.close();
    };
    const helloTimer = setTimeout(() => { if (!session) refuse('No hello in time.', true); }, helloTimeoutMs);
    helloTimer.unref?.();

    transport.onMessage(async (text) => {
      let frame;
      try {
        frame = decode(text, 'agent');
      } catch (err) {
        if (first) {
          first = false;
          clearTimeout(helloTimer);
          return refuse(err instanceof ProtocolError ? err.message : 'Not a frame.');
        }
        log.warn(`agent ${session?.server ?? address}: ${err.message}`);
        return;
      }
      if (first) {
        first = false;
        clearTimeout(helloTimer);
        if (frame.type !== 'hello' && frame.type !== 'enrol') return refuse('The first frame is hello or enrol.');
        let who;
        try {
          who = await verify(frame, { address });
        } catch (err) {
          log.warn(`agent from ${address} refused: ${err.message}`);
          return refuse(String(err.message ?? 'Refused.').slice(0, 300));
        }
        if (closed) return refuse('The controller is stopping.', true);
        const old = sessions.get(who.server);
        if (old) drop(old, { reason: 'Another connection for this server took over.', status: 'replaced' });
        session = { server: who.server, install: who.install, address, agentVersion: frame.agentVersion, transport, pending: new Map(), connectedAt: now(), lastSeenAt: now(), seq: 0 };
        sessions.set(who.server, session);
        transport.send(encode({ type: 'welcome', install: who.install, server: who.server, ...(who.credential ? { credential: who.credential } : {}), expectedAgentVersion: AGENT_VERSION, heartbeatMs }));
        if (frame.facts && typeof frame.facts === 'object') onFacts(who.server, frame.facts);
        onStatus(who.server, 'online', view(session));
        return;
      }
      if (!session || session.dropped) return;
      session.lastSeenAt = now();
      switch (frame.type) {
        case 'heartbeat':
          return;
        case 'facts':
          return onFacts(session.server, frame.facts ?? {});
        case 'result':
        case 'error': {
          const p = session.pending.get(frame.id);
          if (!p) return;
          session.pending.delete(frame.id);
          clearTimeout(p.timer);
          if (frame.type === 'result') p.resolve(frame.data ?? {});
          else p.reject(new AgentError(frame.code, frame.message, frame.problems));
          return;
        }
        case 'log':
        case 'stats':
        case 'stream-end':
          return onStream(session.server, frame);
        default:
          log.warn(`agent ${session.server}: unexpected ${frame.type} frame`);
      }
    });
    transport.onClose(() => {
      clearTimeout(helloTimer);
      if (session) drop(session);
    });
  }

  /** Sends a command to a server's agent; resolves with its data or rejects with AgentError. */
  function command(server, name, args = {}, { timeoutMs = commandTimeoutMs } = {}) {
    const problems = checkCommand(name, args);
    if (problems.length) return Promise.reject(new AgentError('invalid', `The ${name} command is not valid.`, problems));
    const session = sessions.get(server);
    if (!session) return Promise.reject(new AgentError('offline', `${server} is not connected.`));
    const id = `c${(session.seq += 1).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new AgentError('timeout', `${server} did not answer ${name} in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.transport.send(encode({ type: 'command', id, name, args }));
      } catch (err) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(new AgentError(err.code === 'too_large' ? 'invalid' : 'offline', err.message));
      }
    });
  }

  /** Marks servers silent for offlineAfterMs as offline and closes their connections (R3). */
  function check() {
    const t = now();
    for (const s of [...sessions.values()]) if (t - s.lastSeenAt > offlineAfterMs) drop(s);
  }
  const timer = checkMs > 0 ? setInterval(check, checkMs) : null;
  timer?.unref?.();

  /** R12: too many connection attempts from one address in a minute. */
  function limited(address) {
    const t = now();
    const recent = (attempts.get(address) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    attempts.set(address, recent);
    if (attempts.size > 10_000) attempts.clear();
    return recent.length > connectsPerMinute;
  }

  /**
   * An upgrade handler for host.onUpgrade(path, …): plain ws:// only from loopback or private addresses (R3),
   * rate limited per address (R12), frames up to 1 MB.
   */
  function upgradeHandler() {
    wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    return (req, socket, head) => {
      const address = socket.remoteAddress ?? 'unknown';
      const deny = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      if (closed) return deny(503, 'Service Unavailable');
      if (limited(address)) return deny(429, 'Too Many Requests');
      if (!socket.encrypted && !isPrivateAddress(address)) return deny(403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => {
        const closers = [];
        ws.on('close', () => { for (const fn of closers) fn(); });
        ws.on('error', () => ws.terminate());
        attach({
          send: (text) => {
            if (ws.readyState === ws.OPEN) ws.send(text);
          },
          onMessage: (fn) => ws.on('message', (data, isBinary) => { if (!isBinary) fn(data.toString('utf8')); }),
          onClose: (fn) => closers.push(fn),
          close: () => ws.close(1000),
        }, { address });
      });
    };
  }

  return {
    attach,
    command,
    check,
    upgradeHandler,
    isOnline: (server) => sessions.has(server),
    session: (server) => (sessions.has(server) ? view(sessions.get(server)) : null),
    list: () => [...sessions.values()].map(view),
    /** R12: closes a server's connection (removed, revoked: no retry; a restart: retry). */
    disconnect(server, reason = 'This server was removed.', { retry = false } = {}) {
      const s = sessions.get(server);
      if (s) drop(s, { reason, retry });
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const s of [...sessions.values()]) drop(s, { reason: 'The controller is stopping.', retry: true });
      if (wss) {
        for (const ws of wss.clients) ws.terminate();
        await new Promise((r) => wss.close(() => r()));
      }
    },
  };
}
