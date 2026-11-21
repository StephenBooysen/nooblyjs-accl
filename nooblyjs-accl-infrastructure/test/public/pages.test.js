// Every route renders (roadmap phases 0 and 1): each URL in product.md §5 matches the route the frame would pick, and
// that page draws into a DOM (linkedom) with the real UI kit and the real API of a seeded accelerator, in Node.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { PAGES } from '../fixtures/pages.js';
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

let app;
before(async () => {
  app = await startApp({ seed: true });
});
after(async () => {
  await app.close();
});

/** A content area the way the frame hands it over, in a document of its own. */
function fakeView() {
  const { document } = parseHTML('<!doctype html><html><body><main id="view"></main></body></html>');
  return document.getElementById('view');
}

/** The frame's ctx, as far as pages use it, signed in as `person` (Owner by default). */
function fakeCtx(person = { id: 'stevie', name: 'Stevie', accessRole: 'Owner' }) {
  const controller = new AbortController();
  const fetchImpl = (url, options) => fetch(url, { ...options, headers: { ...options.headers, [PERSON_HEADER]: person.id } });
  return {
    app: { name: 'infrastructure', label: 'Cloud', mountPath: MOUNT },
    person,
    signal: controller.signal,
    api: createApi(`${app.base}${MOUNT}/api/v1`, { signal: controller.signal, fetchImpl }),
    sse: { enabled: false, on() {} },
    can: (permission) => (MATRIX[permission] ?? []).includes(person.accessRole),
    isCurrent: () => true,
    abort: () => controller.abort(),
  };
}

async function draw(url, person) {
  const [path, search = ''] = url.split('?');
  const found = matchRoute(routes, path.slice(MOUNT.length) || '/');
  assert.ok(found, `a route matches ${url}`);
  const view = fakeView();
  const ctx = fakeCtx(person);
  await (await found.route.page()).render(view, { params: found.params, query: new URLSearchParams(search), ctx, route: found.route });
  ctx.abort();
  return { found, out: view.innerHTML };
}

for (const expected of PAGES) {
  test(`${expected.url} renders ${expected.page} with the title "${expected.title}"`, async () => {
    const { found, out } = await draw(expected.url);
    assert.deepEqual(found.params, expected.params ?? {});
    assert.match(String(found.route.page), new RegExp(`pages/${expected.page.replace('.', '\\.')}`));
    assert.match(out, new RegExp(`<h1 class="page-title">${escapeHtml(expected.title)}</h1>`), 'one h1 with the page title');
    assert.equal(out.match(/<h1\b/g).length, 1, 'exactly one h1');
    assert.doesNotMatch(out, /Couldn.t load/, 'no error card');
    for (const [, href] of out.matchAll(/href="([^"]*)"/g)) {
      assert.ok(href === MOUNT || href.startsWith(`${MOUNT}/`) || /^https?:\/\/[a-z0-9.-]+\//.test(`${href}/`), `link ${href} stays inside the accelerator or is a public endpoint`);
    }
    if (expected.params) assert.match(out, /aria-label="Breadcrumb"/, 'a detail page has a breadcrumb');
    if (!expected.built) assert.match(out, /Coming in roadmap phase \d/);
  });
}

test('the Overview shows the seed story\'s numbers, as the mockup does', async () => {
  const { out } = await draw('/infrastructure');
  for (const text of [
    '2 cloud accounts · 18 resources', '3 running · 1 stopped · 1 starting', '3 live on HTTPS · 1 building',
    '2 MySQL · 1 MongoDB', '182 GB', '4 buckets · 2 public', 'Create something', 'Launch a Linux VM',
    'shop.example.com', 'storefront · web-01 · GCP', 'VM stopped', 'Certificate pending',
    'docs 77be014 on docs-01', 'Spend this month', 'Estimate · resets', 'stevie-prod', '3 VMs · 2 databases · 2 buckets',
  ]) assert.ok(out.includes(escapeHtml(text)), `the Overview says "${text}"`);
  assert.match(out, /href="https:\/\/shop\.example\.com"/, 'a live endpoint is a link');
  assert.doesNotMatch(out, /href="[^"]*staging\.example\.com/, 'an endpoint whose VM is stopped is not');
});

test('the Accounts page lists both accounts, says it runs on the mock cloud, and offers Connect only to an Owner', async () => {
  const owner = (await draw('/infrastructure/accounts')).out;
  for (const text of ['stevie-prod', 'stevie-aws · 0932', 'Project stevie-prod', 'Account 553219040932', 'Connected', 'Running on the mock cloud', 'Connect account', 'Check now', 'Remove']) {
    assert.ok(owner.includes(text), `the Owner sees "${text}"`);
  }
  const viewer = (await draw('/infrastructure/accounts', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(viewer.includes('stevie-prod'));
  for (const text of ['Connect account', 'Check now', '>Remove<']) assert.ok(!viewer.includes(text), `a Viewer doesn't see "${text}"`);
});

test('the Activity page lists what happened, newest first, and filters by kind', async () => {
  const all = (await draw('/infrastructure/activity')).out;
  assert.ok(all.indexOf('docs 77be014 on docs-01') < all.indexOf('VM staging-01'), 'newest first');
  assert.ok(all.includes('GCP account stevie-prod'));
  const vms = (await draw('/infrastructure/activity?kind=vm')).out;
  assert.ok(vms.includes('VM staging-01'));
  assert.ok(!vms.includes('storefront a1f3c9e'), 'only VMs');
  assert.match(vms, /data-kind="vm" aria-pressed="true"/);
});

test('Virtual machines lists the seed\'s five VMs as the mockup does, with a menu per row', async () => {
  const { out } = await draw('/infrastructure/vms');
  for (const text of [
    '5 Linux VMs across GCP and AWS · 3 running', 'web-01', 'Ubuntu 24.04 LTS', 'africa-south1-a', 'e2-medium', '2 vCPU · 4 GB',
    'Running', 'Stopped', 'Starting · 1 of 3', '203.0.113.24', 'Assigning…', 'Paused while stopped', 'Certificate pending',
    'Private only', 'disk only', 'Actions for web-01', 'Copy SSH command', 'Launch VM', 'Database VMs',
  ]) assert.ok(out.includes(escapeHtml(text)), `the list says "${text}"`);
  assert.match(out, /data-cloud="gcp"[^>]*>GCP <span class="chip__count">3</);
  const viewer = (await draw('/infrastructure/vms', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(!viewer.includes('Launch VM') && !viewer.includes('data-action="stop"') && !viewer.includes('data-action="delete"'), 'a Viewer only looks');
});

test('Launch a Linux VM offers the connected accounts, sizes with prices, and a summary at $30 for the defaults', async () => {
  const { out } = await draw('/infrastructure/vms/new');
  for (const text of [
    'Cloud and region', 'Google Cloud', 'Project stevie-prod', 'Account stevie-aws · 0932', 'africa-south1 · Johannesburg',
    '~$14 / mo', '~$28 / mo', '~$112 / mo', 'Choose any machine type', 'Install Docker on first boot', 'stevie-macbook · ed25519',
    'My IP only · 127.0.0.1', 'Put it on a public address', 'Use the cloud’s address', 'Traffic port', 'Ready in about 2 minutes',
  ]) assert.ok(out.includes(escapeHtml(text)), `the form says "${text}"`);
  assert.match(out, /data-summary="total">\$30</, 'the summary prices e2-medium with 30 GB');
  assert.match(out, /VM \$28 · disk \$2\.04 · billed by GCP to stevie-prod/);
  assert.match(out, /<label class="inf-field__label" for="inf-f-name">Name<\/label>/, 'every control is labelled');
  const viewer = (await draw('/infrastructure/vms/new', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(viewer.includes('needs the draft permission') && !viewer.includes('<form'));
});

test('VM detail shows web-01 as the mockup does', async () => {
  const { out } = await draw('/infrastructure/vms/web-01');
  for (const text of [
    'Running', 'africa-south1-a · e2-medium · Ubuntu 24.04 LTS · up 18 days', 'Open SSH', 'Deploy an app',
    'https://shop.example.com', 'container port 3000', 'Valid', 'Verified', 'storefront', 'github.com/stevie/storefront',
    'main · ./Dockerfile', 'a1f3c9e', 'On push to main', '203.0.113.24 · static', '10.10.0.12', 'ssh ubuntu@203.0.113.24',
    'stevie-macbook · ed25519', '22 (my IP only) · 80 · 443', 'Docker 27 · HTTPS proxy', '$30 / month', 'Danger zone',
  ]) assert.ok(out.includes(escapeHtml(text)), `the page says "${text}"`);
});

test('VM detail: endpoints can be added, changed and removed by a Developer, read by a Viewer, and are paused while stopped', async () => {
  const { out } = await draw('/infrastructure/vms/web-01');
  for (const text of ['Add endpoint', 'Edit shop.example.com', 'Remove shop.example.com', 'Renews before']) assert.ok(out.includes(escapeHtml(text)), `the page says "${text}"`);
  assert.match(out, /data-region="endpoint-form" hidden/);
  const viewer = (await draw('/infrastructure/vms/web-01', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(!viewer.includes('Add endpoint') && !viewer.includes('data-action="endpoint-edit"'), 'a Viewer only reads');
  const stopped = (await draw('/infrastructure/vms/staging-01')).out;
  assert.ok(stopped.includes('Paused while stopped') && !stopped.includes('Add endpoint'));
  const free = (await draw('/infrastructure/vms/worker-01')).out;
  assert.ok(free.includes(escapeHtml('No public endpoints. Add one to reach an app on this VM from the internet')));
});

test('the endpoint form: the cloud\'s address or a domain, path, port, certificate and redirect, every control labelled', async () => {
  const { endpointForm, endpointBody, dnsHint } = await import('../../public/js/components/endpoint-form.js');
  const fresh = String(endpointForm({ vm: { cloud: 'gcp', cloudAddress: '203.0.113.117' } }));
  for (const name of ['domain', 'path', 'port', 'cert', 'certificate', 'privateKey']) assert.match(fresh, new RegExp(`<label class="inf-field__label" for="inf-f-${name}">`), name);
  assert.match(fresh, /value="cloud" checked/);
  assert.match(fresh, /203\.0\.113\.117/);
  const change = String(endpointForm({ vm: { cloud: 'gcp' }, e: { id: 'ep_x1x1', address: 'domain', host: 'shop.example.com', path: '/', port: 3000, redirectHttp: true, certSource: 'upload' } }));
  assert.match(change, /data-address="domain"/);
  assert.doesNotMatch(change, /name="address"/, 'the address kind stays');
  assert.ok(change.includes('Leave empty to keep the one uploaded.'));
  assert.deepEqual(endpointBody({ port: '8080', certificate: '', privateKey: '' }), { port: 8080 });
  assert.match(String(dnsHint({ dns: { text: 'Waiting for DNS record', expect: { type: 'A', name: 'a.example.com', value: '203.0.113.5' }, alt: null } })), /A a\.example\.com → 203\.0\.113\.5/);
  assert.equal(String(dnsHint({ dns: { text: 'Verified', expect: { type: 'A' } } })), '');
});

test('Apps lists the seed\'s six apps as the mockup does, with chips, search and one action per row', async () => {
  const { out } = await draw('/infrastructure/apps');
  for (const text of [
    '6 apps built from Dockerfiles in Git · 3 live on HTTPS', 'Deploy from Git', 'storefront', 'stevie/storefront', 'main · a1f3c9e · auto-deploy',
    'web-01', 'africa-south1', 'shop.example.com', 'Live', 'by push', 'Private · no endpoint', 'Building · queued', 'Stopped with VM',
    'Redeploy', 'Start VM', 'View log', 'Search apps',
  ]) assert.ok(out.includes(escapeHtml(text)), `the list says "${text}"`);
  assert.match(out, /data-status="live"[^>]*>Live <span class="chip__count">4</);
  assert.match(out, /href="https:\/\/shop\.example\.com"/);
  const viewer = (await draw('/infrastructure/apps', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(!viewer.includes('Deploy from Git') && !viewer.includes('data-action="redeploy"'), 'a Viewer only looks');
});

test('Deploy an app from Git: source with the connection, VM cards, run settings, env links, HTTPS and what happens next', async () => {
  const { out } = await draw('/infrastructure/apps/new?vm=worker-01');
  for (const text of [
    'GitHub connected as', 'stevie', '24 repositories', 'Use another Git host', 'Repository URL', 'Branch', 'Dockerfile path', 'Build context',
    'Redeploy when', 'is pushed', 'Where it runs', 'web-01', 'api-01', 'Launch a new VM for this app', 'App name', 'Container port',
    'Restart policy', 'Environment variables', 'Add variable', 'Link a database', 'Link a bucket', 'Serve this app on HTTPS', 'Use my own domain',
    'Health check', 'What happens next', 'Build the image on worker-01', 'GET /healthz must return 200', 'No extra cost · runs on worker-01',
  ]) assert.ok(out.includes(escapeHtml(text)), `the form says "${text}"`);
  assert.match(out, /value="worker-01" checked/, 'the VM asked for is picked');
  assert.match(out, /value="staging-01" disabled/, 'a stopped VM can\'t be picked');
  for (const name of ['repo', 'branch', 'gitConnection', 'dockerfile', 'context', 'name', 'port', 'restart', 'endpoint.domain', 'endpoint.path', 'healthCheck']) {
    assert.match(out, new RegExp(`<label class="inf-field__label" for="inf-f-${name.replace('.', '\\.')}">`), `${name} is labelled`);
  }
  const viewer = (await draw('/infrastructure/apps/new', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(viewer.includes('needs the draft permission') && !viewer.includes('<form'));
});

test('App detail: where it runs, the environment with secrets hidden, deploys with their log, and the actions a person may take', async () => {
  const { out } = await draw('/infrastructure/apps/storefront');
  for (const text of [
    'stevie/storefront @ main · on web-01', 'Live', 'Redeploy', 'Where it runs', 'https://shop.example.com', 'via github-stevie',
    'GET /healthz', 'On push to main', 'NODE_ENV', 'production', 'DATABASE_URL', 'Linked to', 'catalog', 'MEDIA_BUCKET', 'Deploys',
    'a1f3c9e', 'Faster product images', 'View log', 'Logs', 'Show the last 200 lines', 'Danger zone', 'Delete app',
  ]) assert.ok(out.includes(escapeHtml(text)), `the page says "${text}"`);
  assert.match(out, /href="\/infrastructure\/databases\/catalog"/);
  const viewer = (await draw('/infrastructure/apps/storefront', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(!viewer.includes('data-action="redeploy"') && !viewer.includes('Delete app'), 'a Viewer only reads');
  const docs = (await draw('/infrastructure/apps/docs')).out;
  assert.ok(docs.includes('Building · queued') && docs.includes('Check the source') && docs.includes('Queued: Deploy docs to docs-01'), 'a deploy in progress shows its steps and log');
  const gone = (await draw('/infrastructure/apps/nope')).out;
  assert.ok(gone.includes('No app nope'));
});

test('Cloud accounts lists the Git connections, and only an Owner adds, checks or removes one', async () => {
  const owner = (await draw('/infrastructure/accounts')).out;
  for (const text of ['Git connections', 'Add Git connection', 'GitHub', 'github-stevie', '24', 'Connected', 'storefront']) assert.ok(owner.includes(escapeHtml(text)), `the Owner sees "${text}"`);
  assert.match(owner, /data-action="git-test" data-id="github-stevie"/);
  const viewer = (await draw('/infrastructure/accounts', { id: 'naledi-k', name: 'Naledi K.', accessRole: 'Viewer' })).out;
  assert.ok(viewer.includes('github-stevie') && !viewer.includes('Add Git connection') && !viewer.includes('data-action="git-remove"'));
});

test('VM detail: the latest deploy with its log, and its apps linked to their pages', async () => {
  const { out } = await draw('/infrastructure/vms/web-01');
  for (const text of ['Latest deploy · ', 'storefront', 'Finished in 60s', 'https://shop.example.com now goes to storefront-a1f3c9e-op01']) assert.ok(out.includes(escapeHtml(text)), `the page says "${text}"`);
  assert.match(out, /href="\/infrastructure\/apps\/storefront"/);
});

test('a name in the URL is escaped, never markup', async () => {
  const { out } = await draw('/infrastructure/vms/%3Cimg%20src%3Dx%3E');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x&gt;/);
});
