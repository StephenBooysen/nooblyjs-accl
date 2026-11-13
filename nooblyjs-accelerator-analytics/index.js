/**
 * @fileoverview Analytics accelerator: the metrics screen for the NooblyJS accelerators.
 *
 * The launcher calls register(app, serviceRegistry, { mountPath }) and the screen is served under
 * /applications/analytics. This first version is the shell: the page, its status API and the empty state. Metric
 * definitions and the sources that feed them are added as described in .claude/specs/initial-scope.md (R3, R4).
 *
 * @module nooblyjs-accelerator-analytics
 */

'use strict';

const SOURCES = Object.freeze([
  { name: 'commerce', title: 'Commerce', status: 'not connected' },
  { name: 'customer', title: 'Customers', status: 'not connected' },
  { name: 'infrastructure', title: 'Infrastructure', status: 'not connected' },
]);

const DEFAULT_MOUNT = '/applications/analytics';

/**
 * Renders the screen. Shows the empty state, since no source is connected yet.
 *
 * @param {string} mountPath - where the screen is mounted, used for links and the stylesheet
 * @return {string} HTML document
 */
function renderPage(mountPath) {
  const rows = SOURCES.map((s) => `<li><strong>${s.title}</strong>: ${s.status}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analytics</title>
<style>
  :root { --bg: #ffffff; --fg: #1d1d1f; --muted: #6b6b70; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111114; --fg: #f2f2f4; --muted: #9a9aa2; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
  main { padding: 16px; max-width: 720px; }
  h1 { font-size: 1.5rem; }
  p, li { color: var(--muted); }
</style></head>
<body><main>
<h1>Analytics</h1>
<p>No metrics yet. The dashboard reads from the accelerators once their sources are connected.</p>
<ul>${rows}</ul>
<p><a href="${mountPath}/api/status">Status (JSON)</a></p>
</main></body></html>`;
}

/**
 * Adds the analytics screen to a launcher's app.
 *
 * @param {import('express').Express} app - the launcher's Express app
 * @param {Object} serviceRegistry - nooblyjs-core registry, already initialised by the launcher (not used yet)
 * @param {Object} [options]
 * @param {string} [options.mountPath='/applications/analytics']
 * @return {{name: string, mountPath: string, sources: Array<Object>}}
 */
function register(app, serviceRegistry, { mountPath = DEFAULT_MOUNT } = {}) {
  if (typeof app?.get !== 'function') throw new Error('analytics register needs the launcher\'s Express app');
  if (!/^\/applications\/[a-z0-9][a-z0-9-]{0,62}$/.test(mountPath)) {
    throw new Error(`mountPath must look like /applications/analytics, not ${JSON.stringify(mountPath)}`);
  }

  app.get(mountPath, (req, res) => res.type('html').send(renderPage(mountPath)));
  app.get(`${mountPath}/api/status`, (req, res) => res.json({
    status: 'running',
    application: 'Analytics',
    sources: SOURCES,
    timestamp: new Date().toISOString(),
  }));

  return { name: 'analytics', mountPath, sources: SOURCES };
}

module.exports = { register, renderPage, SOURCES, DEFAULT_MOUNT };
