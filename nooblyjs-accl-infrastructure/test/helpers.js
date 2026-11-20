// Runs the accelerator the way a launcher does, on a bare Express app (5, or 4 under `npm run test:express4`) with the
// stand-in host, on port 0 and a temp data folder. A fallback after the accelerator answers anything it passes on, so
// tests can see it called next().
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mount } from '../index.js';
import { createHost, createTestServiceRegistry, express, PERSON_HEADER } from './fixtures/host.js';

export const FALLBACK = 'host fallback';

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nooblyjs-accelerator-infrastructure-'));
}

/** Listens on port 0; resolves to { server, base }. */
export async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** fetch as a person (by id), or signed out with `as: null`. JSON bodies are sent as JSON. */
export function caller(base) {
  return async (method, url, { as = null, body, headers = {}, redirect = 'follow' } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect,
      headers: {
        ...(as ? { [PERSON_HEADER]: as } : {}),
        ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.mountPath]
 * @param {(host: object) => object} [o.changeHost]   alter the host before mount() (to test refusals)
 * @param {object} [o.serviceRegistry]
 * @param {object} [o.eventEmitter]   the launcher's shared emitter (a new one by default)
 * @param {boolean} [o.seed]   write the seed story first
 * @param {(dataDir: string) => Promise<void>} [o.before]   writes files before mount() runs (restart tests)
 * @param {number} [o.mockStepMs]   the mock cloud's pace (0: cloud work finishes at once)
 * @param {object} [o.platform]   mount()'s platform option ({ enabled: true } for the platform layer, spec 8.1)
 * @param {object} [o.agents]     mount()'s agents option (spec 8.9: verify and timings)
 */
export async function startApp({ mountPath = '/infrastructure', changeHost = (h) => h, serviceRegistry = createTestServiceRegistry(), eventEmitter = new EventEmitter(), seed = false, before, mockStepMs = 0, platform, agents, local } = {}) {
  const rootDir = await tempDir();
  const dataDir = path.join(rootDir, mountPath.replace(/^\//, '') || 'root');
  await fs.mkdir(dataDir, { recursive: true });
  if (before) await before(dataDir);
  const stand = createHost({ rootDir });
  const app = express();

  let hosted = null;
  let mountError = null;
  try {
    hosted = await mount(app, eventEmitter, serviceRegistry, { mountPath, dataDir, host: changeHost(stand.hostFor(dataDir)), mockStepMs, jobCheckMs: 0, ...(platform ? { platform } : {}), ...(agents ? { agents } : {}), ...(local ? { local } : {}) });
  } catch (err) {
    mountError = err;
  }
  if (seed && hosted) await hosted.seed({ reset: true });
  app.use((req, res) => res.status(404).type('text').send(FALLBACK));

  const { server, base } = await listen(app);
  stand.attachUpgrades(server);
  const call = caller(base);

  return {
    app,
    base,
    server,
    rootDir,
    dataDir,
    hosted,
    mountError,
    serviceRegistry,
    eventEmitter,
    auditLog: stand.auditLog,
    eventLog: stand.eventLog,
    get: (url, o) => call('GET', url, o),
    post: (url, o) => call('POST', url, o),
    put: (url, o) => call('PUT', url, o),
    delete: (url, o) => call('DELETE', url, o),
    async close() {
      await hosted?.close();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
export async function filesUnder(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll(path.sep, '/'))
    .sort();
}
