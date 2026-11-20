// The operators' Platform screen (spec 8.1.6), drawn into a DOM (linkedom) with the real UI kit and the real API of an
// accelerator mounted with the platform on and the seed story; and what it says when the platform is off or the person
// is not an operator.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { startApp } from '../helpers.js';
import { MATRIX, PERSON_HEADER } from '../fixtures/host.js';

const require = createRequire(import.meta.url);
const { UI_DIR } = require('nooblyjs-core/src/shell');
register('../fixtures/ui-loader.js', import.meta.url, { data: { uiDir: UI_DIR } });

const MOUNT = '/infrastructure';
const { routes } = await import('../../public/js/module.js');
const { matchRoute } = await import('/ui/js/router.js');
const { escapeHtml } = await import('/ui/js/html.js');
const { createApi } = await import('/ui/js/api.js');

const apps = [];
after(async () => {
  for (const a of apps) await a.close();
});

async function draw(app, person = { id: 'stevie', name: 'Stevie', accessRole: 'Owner' }) {
  const found = matchRoute(routes, '/platform');
  const { document } = parseHTML('<!doctype html><html><body><main id="view"></main></body></html>');
  const view = document.getElementById('view');
  const controller = new AbortController();
  const fetchImpl = (url, options) => fetch(url, { ...options, headers: { ...options.headers, [PERSON_HEADER]: person.id } });
  const ctx = {
    app: { name: 'infrastructure', label: 'Cloud', mountPath: MOUNT },
    person,
    signal: controller.signal,
    api: createApi(`${app.base}${MOUNT}/api/v1`, { signal: controller.signal, fetchImpl }),
    sse: { enabled: false, on() {} },
    can: (permission) => (MATRIX[permission] ?? []).includes(person.accessRole),
    isCurrent: () => true,
  };
  await (await found.route.page()).render(view, { params: found.params, query: new URLSearchParams(), ctx, route: found.route });
  controller.abort();
  return { found, out: view.innerHTML };
}

test('the Platform screen lists the seed tenant\'s workloads, read-only', async () => {
  const app = await startApp({ seed: true, platform: { enabled: true } });
  apps.push(app);
  const { found, out } = await draw(app);
  assert.equal(found.route.nav, 'platform');
  assert.match(out, /<h1 class="page-title">Platform<\/h1>/);
  assert.equal(out.match(/<h1\b/g).length, 1);
  for (const text of [
    '1 tenant · 6 workloads · 5 live', 'exclusivity-life', 'api', 'Web service', '2 × 1 vCPU · 2 GB', 'api-exclusivity.nooblyjs.app',
    'Private service', 'Inside the tenant only', 'Static site', 'Files only', 'Schedule 0 2 * * *', 'Last run succeeded', 'Deploying', 'a1f3c9e',
    'af-south-1: 6 instances', 'Shared host VMs arrive with spec 8.2',
  ]) assert.ok(out.includes(escapeHtml(text)), `the screen says "${text}"`);
  assert.doesNotMatch(out, /<button|<form/, 'nothing to press: read-only');
  assert.doesNotMatch(out, /style=/);
});

test('without the platform it says the layer is off; a non-operator sees no workloads', async () => {
  const off = await startApp({ seed: true });
  apps.push(off);
  assert.match((await draw(off)).out, /The platform layer is off/);
  const on = await startApp({ seed: true, platform: { enabled: true } });
  apps.push(on);
  const viewer = (await draw(on, { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.match(viewer, /Operators only/);
  assert.doesNotMatch(viewer, /exclusivity-life/);
});
