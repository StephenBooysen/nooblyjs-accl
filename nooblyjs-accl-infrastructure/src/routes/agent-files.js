// The agent's downloads (spec 8.9 R2, task 8.9.10): <mountPath>/agent/install.sh with the controller's URL filled in,
// and the fixed list of files it fetches from <mountPath>/agent/files/<file>. A server being set up has no sign-in, so
// these answer without one: they are the agent's own source and carry no secret (the one-time token is passed to the
// script on its command line, never served). A launcher that gates its mount must let exactly AGENT_PUBLIC through.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent');
export const AGENT_FILES = ['package.json', 'protocol.js', 'core.js', 'connect.js', 'docker.js', 'bin/noobly-agent.js'];
/** The paths, under the mount, that answer without a sign-in. */
export const AGENT_PUBLIC = ['/agent/install.sh', ...AGENT_FILES.map((f) => `/agent/files/${f}`)];
const CONTROLLER = /^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._/-]*)?$/;

/** The controller URL as the script sees it, or null when the request's host is not one we would write into a script. */
export function controllerOf(req, mountPath) {
  const url = `${req.protocol}://${req.get('host') ?? ''}${mountPath}`;
  return CONTROLLER.test(url) ? url : null;
}

export function agentFileRoutes({ host, mountPath }) {
  const r = host.express.Router();
  const type = (f) => (f.endsWith('.json') ? 'application/json' : 'text/javascript');

  r.get('/agent/install.sh', async (req, res, next) => {
    try {
      const script = await fs.readFile(path.join(AGENT_DIR, 'install.sh'), 'utf8');
      const controller = controllerOf(req, mountPath);
      // Without a usable URL the placeholder stays, and the script asks for --controller.
      res.set('Content-Type', 'text/x-shellscript; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(controller ? script.replace('"__CONTROLLER__"', `"${controller}"`) : script);
    } catch (err) {
      next(err);
    }
  });

  for (const f of AGENT_FILES) {
    r.get(`/agent/files/${f}`, (req, res, next) => {
      res.set('Content-Type', `${type(f)}; charset=utf-8`);
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(AGENT_DIR, f), (err) => err && next(err));
    });
  }
  return r;
}
