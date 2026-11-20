// The agent's connection to the controller (spec 8.9 R3): Node 22's built-in WebSocket client, so the agent needs no
// packages. Reconnects with backoff (1 s doubling to 30 s, with jitter) until the controller refuses it without
// `retry` (a removed server, a used token) or stop() is called. Plain ws:// is allowed only to localhost, a loopback
// or a private (RFC 1918) address: the LAN mode.
import net from 'node:net';
import { startSession } from './core.js';

const PRIVATE = (host) => {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/i.test(h);
};

/** The agent endpoint for a controller URL (http(s)://host[:port][/mount] or ws(s)://…/agent/v1); throws when not allowed. */
export function agentUrl(controller, mountPath = '/infrastructure') {
  const u = new URL(controller);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('The controller URL is http(s):// or ws(s)://.');
  if (u.username || u.password) throw new Error('The controller URL carries no credentials.');
  if (u.protocol === 'ws:' && !PRIVATE(u.hostname)) throw new Error('Plain ws:// is only for localhost or a private address; use https://.');
  if (!u.pathname.endsWith('/agent/v1')) u.pathname = `${u.pathname.replace(/\/$/, '') || mountPath}/agent/v1`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Backoff for attempt n (0-based): 1 s doubling to 30 s, ±25% jitter. */
export const backoffMs = (n, random = Math.random) => Math.round(Math.min(30_000, 1000 * 2 ** n) * (0.75 + random() / 2));

/** A WebSocket as the session's transport. */
function wsTransport(ws) {
  const messages = [];
  const closers = [];
  ws.addEventListener('message', (e) => { if (typeof e.data === 'string') for (const fn of messages) fn(e.data); });
  ws.addEventListener('close', () => { for (const fn of closers) fn(); });
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* closing */ } });
  return {
    send: (text) => ws.send(text),
    onMessage: (fn) => messages.push(fn),
    onClose: (fn) => closers.push(fn),
    close: () => { try { ws.close(1000); } catch { /* closing */ } },
  };
}

/**
 * Keeps the agent connected.
 * @param {object} o
 * @param {string} o.controller            e.g. http://localhost:11010 or https://cloud.example.com
 * @param {() => object} o.identity        read each attempt: { server, credential } or { token }
 * @param {object} o.docker
 * @param {() => Promise<object>} o.facts
 * @param {boolean} [o.dev]
 * @param {(w: object) => Promise<void>|void} o.onWelcome   keeps a new credential (and drops the token)
 * @param {{ info: Function, warn: Function }} [o.log]
 * @param {typeof WebSocket} [o.WebSocketImpl]
 * @returns {{ stop(): void, done: Promise<{ reason: string }> }}
 */
export function connectForever({ controller, identity, docker, facts, dev = false, onWelcome, log = console, WebSocketImpl = globalThis.WebSocket }) {
  const url = agentUrl(controller);
  let stopped = false;
  let attempt = 0;
  let current = null;
  let wait = null;
  let finish;
  const done = new Promise((r) => { finish = r; });

  const end = (reason) => {
    stopped = true;
    if (wait) clearTimeout(wait);
    finish({ reason });
  };

  function connect() {
    if (stopped) return;
    const ws = new WebSocketImpl(url);
    let refused = null;
    ws.addEventListener('open', () => {
      if (stopped) return ws.close(1000);
      current = startSession({
        transport: wsTransport(ws),
        docker,
        identity: identity(),
        facts,
        dev,
        onWelcome: async (w) => {
          attempt = 0;
          log.info(`connected to ${url} as ${w.server}`);
          await onWelcome?.(w);
        },
        onRefused: (reason, { retry }) => { refused = { reason, retry }; },
        onError: (err) => log.warn(`agent: ${err.message}`),
      });
    }, { once: true });
    ws.addEventListener('close', () => {
      current = null;
      if (stopped) return;
      if (refused && !refused.retry) {
        log.warn(`the controller refused this agent: ${refused.reason}`);
        return end(refused.reason);
      }
      const ms = backoffMs(attempt++);
      log.info(`${refused ? refused.reason : 'disconnected'}; trying again in ${Math.round(ms / 1000)} s`);
      wait = setTimeout(connect, ms);
    }, { once: true });
  }
  connect();

  return {
    stop() {
      end('stopped');
      current?.stop();
    },
    done,
  };
}
