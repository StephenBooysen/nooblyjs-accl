// Apps (infra-apps/Apps.dc.html; product.md §6.5; roadmap 6.6): every app built from a Dockerfile in Git, with its
// source, the VM it runs on, its endpoint, its status and its last deploy; filtered by status and searched by name,
// repository, VM or domain without asking the server again. Each row has the one action that fits: Redeploy, View log
// while it builds, or Start VM when its VM is stopped. Data: GET /apps.
import { pageHead, statusPill, dataTable, chips, card } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { html, button, hrefFor, errorCard, isAbort, reloadable, say, messageRegion, progressBar, REFRESH_MS } from '../lib.js';
import { cloudBadge } from '../components/index.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
/** Which chip an app counts under. */
const GROUP = { live: 'live', building: 'building', stopped: 'stopped', 'stopped-with-vm': 'stopped', stopping: 'building', starting: 'building', deleting: 'building', failed: 'attention', crashed: 'attention' };

function filtersFor(apps) {
  const count = (g) => apps.filter((a) => GROUP[a.status] === g).length;
  return [
    { value: 'all', label: 'All', count: apps.length },
    { value: 'live', label: 'Live', count: count('live') },
    { value: 'building', label: 'Building', count: count('building') },
    { value: 'stopped', label: 'Stopped', count: count('stopped') },
    ...(count('attention') ? [{ value: 'attention', label: 'Needs attention', count: count('attention') }] : []),
  ];
}

function endpointCell(a) {
  if (!a.endpoint) return html`<span class="inf-muted">Private · no endpoint</span>`;
  const label = `${a.endpoint.host}${a.endpoint.path && a.endpoint.path !== '/' ? a.endpoint.path : ''}`;
  return html`${a.endpoint.live && a.endpoint.url ? html`<a class="inf-mono" href="${a.endpoint.url}" rel="noopener">${label}</a>` : html`<span class="inf-mono inf-muted">${label}</span>`}${a.endpoint.note ? html`<span class="inf-sub">${a.endpoint.note}</span>` : ''}`;
}

function lastDeploy(a) {
  if (a.operation?.type === 'app.deploy') return html`Now<span class="inf-sub">${a.operation.by ? `by ${a.operation.by}` : 'by push'}</span>`;
  if (!a.lastDeploy) return html`<span class="inf-muted">Never</span>`;
  return html`<time datetime="${a.lastDeploy.at}">${ago(a.lastDeploy.at)}</time><span class="inf-sub">${a.lastDeploy.by}</span>`;
}

function action(a, ctx) {
  const name = a.name;
  if (a.can.viewLog) return button({ label: 'View log', kind: 'secondary', small: true, href: hrefFor(ctx, `/apps/${name}#deploy-log`) });
  if (!ctx.can('draft')) return '';
  if (a.can.startVm) return button({ label: 'Start VM', kind: 'secondary', small: true, attrs: { 'data-action': 'start-vm', 'data-vm': a.vm, 'aria-label': `Start ${a.vm}, the VM ${name} runs on` } });
  if (a.can.redeploy) return button({ label: 'Redeploy', kind: 'secondary', small: true, attrs: { 'data-action': 'redeploy', 'data-name': name, 'aria-label': `Redeploy ${name}` } });
  return '';
}

function table(apps, ctx, filter) {
  return dataTable({
    caption: 'Apps',
    empty: filter === 'all' ? 'No apps yet. Deploy one from Git to start.' : 'No apps match.',
    rows: apps,
    columns: [
      { key: 'name', label: 'App', render: (a) => html`<a class="inf-strong-link" href="${hrefFor(ctx, `/apps/${a.name}`)}">${a.name}</a>${a.problem ? html`<span class="inf-sub inf-tone inf-tone--warning">${a.problem}</span>` : ''}` },
      { key: 'source', label: 'Source', render: (a) => html`<span class="inf-mono">${a.repo}</span><span class="inf-sub">${[a.branch, a.commit, a.autoDeploy ? 'auto-deploy' : null].filter(Boolean).join(' · ')}</span>` },
      { key: 'vm', label: 'Runs on', render: (a) => html`<a class="inf-mono" href="${hrefFor(ctx, `/vms/${a.vm}`)}">${a.vm}</a><span class="inf-sub inf-inline">${a.cloud ? cloudBadge(a.cloud) : ''}${a.region ?? ''}</span>` },
      { key: 'endpoint', label: 'Endpoint', render: endpointCell },
      { key: 'status', label: 'Status', render: (a) => (a.operation?.status === 'running' ? progressBar(a.statusText, a.operation.progress) : statusPill({ text: a.statusText, tone: a.tone })) },
      { key: 'deploy', label: 'Last deploy', render: lastDeploy },
      { key: 'actions', label: html`<span class="visually-hidden">Actions</span>`, render: (a) => action(a, ctx) },
    ],
  });
}

export async function render(view, { query, ctx }) {
  let filter = ['live', 'building', 'stopped', 'attention'].includes(query.get('status')) ? query.get('status') : 'all';
  let search = query.get('q') ?? '';
  let apps = [];

  view.innerHTML = String(html`${pageHead({ title: 'Apps', lead: ' ', actions: ctx.can('draft') ? button({ label: 'Deploy from Git', icon: 'plus', href: hrefFor(ctx, '/apps/new') }) : '' })}
    ${messageRegion()}
    <div class="inf-toolbar"><div data-region="chips"></div><div class="inf-toolbar__search"><label class="visually-hidden" for="inf-app-search">Search apps</label><input class="inf-input" id="inf-app-search" type="search" placeholder="Search by name, repository, VM or domain" autocomplete="off"></div></div>
    <div data-region="table"></div>`);
  const lead = view.querySelector('.page-head .lead');
  const chipsRegion = view.querySelector('[data-region="chips"]');
  const tableRegion = view.querySelector('[data-region="table"]');
  const searchBox = view.querySelector('#inf-app-search');
  searchBox.value = search;

  const drawTable = () => {
    const needle = search.trim().toLowerCase();
    const shown = apps
      .filter((a) => filter === 'all' || GROUP[a.status] === filter)
      .filter((a) => !needle || [a.name, a.repo, a.vm, a.endpoint?.host].filter(Boolean).some((s) => s.toLowerCase().includes(needle)));
    const pressed = view.ownerDocument?.activeElement?.closest?.('[data-status]')?.dataset.status;
    chipsRegion.innerHTML = String(chips({ label: 'Filter by status', name: 'status', items: filtersFor(apps), current: filter, small: true }));
    if (pressed) chipsRegion.querySelector(`[data-status="${pressed}"]`)?.focus();
    tableRegion.innerHTML = String(card({ label: 'App list', body: table(shown, ctx, filter) }));
  };

  const redraw = await reloadable(tableRegion, ctx, async () => {
    let counts;
    try {
      ({ apps, counts } = await ctx.api.get('apps'));
    } catch (err) {
      if (!isAbort(err)) tableRegion.innerHTML = String(errorCard(err, 'the apps'));
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    lead.textContent = apps.length ? `${plural(counts.all, 'app')} built from Dockerfiles in Git · ${counts.https} live on HTTPS` : 'Apps are built from a Dockerfile in Git and run on your VMs.';
    drawTable();
    return apps.some((a) => a.operation) ? REFRESH_MS : 0;
  });

  searchBox.addEventListener('input', () => {
    search = searchBox.value;
    drawTable();
  }, { signal: ctx.signal });

  view.addEventListener('click', async (event) => {
    const chip = event.target.closest?.('[data-status]');
    if (chip) {
      filter = chip.dataset.status;
      drawTable();
      return;
    }
    const target = event.target.closest?.('[data-action]');
    if (!target || target.dataset.action === 'reload') return;
    target.disabled = true;
    try {
      if (target.dataset.action === 'redeploy') {
        await ctx.api.post(`apps/${encodeURIComponent(target.dataset.name)}/deploy`);
        say(view, `Redeploying ${target.dataset.name} from the latest commit.`, 'success');
      } else if (target.dataset.action === 'start-vm') {
        await ctx.api.post(`vms/${encodeURIComponent(target.dataset.vm)}/start`);
        say(view, `Starting ${target.dataset.vm}. Its apps start with it.`, 'success');
      }
      await redraw();
    } catch (err) {
      if (!isAbort(err)) say(view, err.message, 'error');
    } finally {
      target.disabled = false;
    }
  }, { signal: ctx.signal });
}
