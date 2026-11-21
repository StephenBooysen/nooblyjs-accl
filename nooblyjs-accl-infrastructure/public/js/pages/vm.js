// VM detail (infra-vm-detail/VMDetail.dc.html; product.md §6.4): status and what the VM is, its operation under way
// (with its steps and Cancel), health, HTTPS endpoints, the apps on it, its details and the work done on it, and a
// danger zone. Data: GET /vms/:name; health (GET /vms/:name/health) is drawn when it arrives, so a slow SSH never
// holds the page. Endpoints (roadmap phase 3) are added, changed and removed here: POST /vms/:name/endpoints,
// PATCH and DELETE /endpoints/:id. An open endpoint form is kept, as typed and focused, when the page redraws.
import { pageHead, statusPill, dataTable, card, notice, statCard } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { html, button, hrefFor, crumbs, errorCard, isAbort, reloadable, say, messageRegion, progressBar, REFRESH_MS } from '../lib.js';
import { cloudBadge, kv, copyField, wireCopy, confirmDialog } from '../components/index.js';
import { usd } from '../shared/estimate.js';
import { formValues, showFieldErrors } from '../forms.js';
import { endpointForm, syncEndpointForm, endpointBody, dnsHint } from '../components/endpoint-form.js';

const gb = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
const STEP = { done: 'Done', skipped: 'Skipped', running: 'Under way', pending: 'To do', failed: 'Failed' };

function operationCard(op, ctx) {
  return card({
    title: op.label,
    meta: op.statusText,
    body: html`${progressBar(op.statusText, op.progress)}
      <ol class="inf-steps">${op.steps.map((s) => html`<li class="inf-steps__step inf-steps__step--${s.status}"><span class="inf-steps__label">${s.label}</span><span class="inf-sub">${STEP[s.status] ?? s.status}</span></li>`)}</ol>
      ${op.cancellable && ctx.can('draft') ? html`<div class="actions">${button({ label: 'Cancel', kind: 'secondary', small: true, attrs: { 'data-action': 'cancel', 'data-id': op.id } })}</div>` : ''}`,
  });
}

function healthTiles(h) {
  if (!h) return html`<p class="inf-muted">Reading health…</p>`;
  if (h.problem) return html`<p class="inf-muted">${h.problem}</p>`;
  const pct = (used, total) => `${Math.round((used / total) * 100)}% used`;
  return html`${statCard({ label: 'CPU · last hour', value: h.cpuPercent === null ? '—' : `${h.cpuPercent}%` })}
    ${statCard({ label: 'Memory', value: h.memory ? `${gb(h.memory.usedGb)} / ${gb(h.memory.totalGb)} GB` : '—', note: h.memory ? pct(h.memory.usedGb, h.memory.totalGb) : null })}
    ${statCard({ label: 'Disk', value: h.disk ? `${gb(h.disk.usedGb)} / ${gb(h.disk.totalGb)} GB` : '—', note: h.disk ? pct(h.disk.usedGb, h.disk.totalGb) : null })}
    ${statCard({ label: 'Requests · 24 h', value: h.requests ? h.requests.total.toLocaleString('en-US') : '—', note: !h.requests ? 'Counted once it has an HTTPS endpoint.' : h.requests.okPercent === null ? 'None yet' : `${h.requests.okPercent}% returned 2xx or 3xx` })}`;
}

const APP_STATUS = { live: ['Live', 'success'], building: ['Building', 'warning'], stopped: ['Stopped', 'neutral'], failed: ['Failed', 'danger'], crashed: ['Crashed', 'danger'] };
const DEPLOY_DONE = { live: 'Finished', failed: 'Failed', cancelled: 'Cancelled' };

/** The newest deploy of an app on this VM, with the end of its log (the mockup's "Latest deploy" card). */
function latestDeployCard(d, ctx) {
  const ended = DEPLOY_DONE[d.status];
  return card({
    title: html`Latest deploy · <a href="${hrefFor(ctx, `/apps/${d.app}`)}">${d.app}</a>`,
    meta: ended ? `${ended}${d.seconds !== null ? ` in ${d.seconds}s` : ''}` : 'In progress',
    body: d.lines.length
      ? html`${d.more ? html`<p class="inf-sub">${d.more} earlier lines on the app’s page.</p>` : ''}<pre class="inf-log" tabindex="0" aria-label="Latest deploy log">${d.lines.map((l) => html`<span class="inf-log__line"><span class="inf-log__at">${String(l.at).slice(11, 19)}</span>${l.text}</span>\n`)}</pre>${d.reason ? html`<p class="inf-tone inf-tone--danger">${d.reason}</p>` : ''}`
      : html`<p class="inf-muted">Waiting to start.</p>`,
  });
}

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const where = (e) => `${e.host}${e.path && e.path !== '/' ? e.path : ''}`;
/** Whether endpoints can be added to this VM now, by this person. */
const canAddEndpoint = (vm, ctx) => ctx.can('draft') && vm.role !== 'database' && vm.status === 'running' && !vm.missing && !vm.operation;

function endpointsCard(vm, ctx) {
  const may = ctx.can('draft') && vm.role !== 'database';
  const columns = [
    {
      key: 'host',
      label: 'Address',
      render: (e) => html`${e.url ? html`<a class="inf-mono" href="${e.url}" rel="noopener">${e.url}</a>` : html`<span class="inf-mono">${where(e)}</span>`}${e.statusText ? html`<span class="inf-sub">${statusPill({ text: e.statusText, tone: e.status === 'failed' ? 'danger' : 'warning', dot: false })}</span>` : ''}${e.note ? html`<span class="inf-sub">${e.note}</span>` : ''}`,
    },
    { key: 'app', label: 'Routes to', render: (e) => html`${e.app ?? 'Port'}${e.port ? html`<span class="inf-sub inf-mono">container port ${e.port}</span>` : ''}` },
    {
      key: 'cert',
      label: 'Certificate',
      render: (e) => html`${statusPill({ text: e.cert.text, tone: e.cert.tone })}${e.cert.expiresAt ? html`<span class="inf-sub">${e.certSource === 'letsencrypt' ? 'Renews before' : 'Expires'} ${shortDate(e.cert.expiresAt)}</span>` : ''}${e.certSource === 'upload' ? html`<span class="inf-sub">Uploaded</span>` : ''}`,
    },
    { key: 'dns', label: 'DNS', render: (e) => statusPill({ text: e.dns.text, tone: e.dns.tone, dot: false }) },
  ];
  if (may) {
    columns.push({
      key: 'actions',
      label: 'Actions',
      render: (e) => html`<span class="actions">${e.can.change && !vm.operation ? button({ label: 'Edit', kind: 'secondary', small: true, attrs: { 'data-action': 'endpoint-edit', 'data-id': e.id, 'aria-label': `Edit ${where(e)}` } }) : ''}${(e.can.remove && !vm.operation) || e.status === 'failed' ? button({ label: 'Remove', kind: 'secondary', small: true, attrs: { 'data-action': 'endpoint-remove', 'data-id': e.id, 'aria-label': `Remove ${where(e)}` } }) : ''}</span>`,
    });
  }
  const failures = vm.endpoints.filter((e) => e.failure);
  const hints = [...new Map(vm.endpoints.filter((e) => e.dns?.expect && e.dns.text !== 'Verified' && !e.paused).map((e) => [e.host, e])).values()];
  const selfSigned = vm.endpoints.some((e) => e.cert.text === 'Self-signed');
  const empty = vm.role === 'database' ? 'A database VM has no public endpoints.'
    : vm.status === 'running' ? 'No public endpoints. Add one to reach an app on this VM from the internet; ports 80 and 443 open while it has one.'
      : `No public endpoints. Start ${vm.name} to add one.`;
  return card({
    title: 'HTTPS endpoints',
    meta: 'Public addresses that route to containers on this VM',
    body: html`${vm.endpoints.length ? dataTable({ caption: 'HTTPS endpoints', rows: vm.endpoints, columns }) : html`<p class="inf-muted">${empty}</p>`}
      ${failures.map((e) => html`<p class="inf-note"><span class="inf-tone inf-tone--danger">${where(e)}:</span> ${e.failure}</p>`)}
      ${hints.map((e) => dnsHint(e))}
      ${selfSigned ? html`<p class="inf-note">The cloud’s address has a self-signed certificate: browsers warn about it. Add your own domain for a trusted one.</p>` : ''}
      ${canAddEndpoint(vm, ctx) ? html`<div class="actions" data-region="endpoint-add">${button({ label: 'Add endpoint', kind: 'secondary', icon: 'plus', attrs: { 'data-action': 'endpoint-add' } })}</div>` : ''}
      <div data-region="endpoint-form" hidden></div>`,
  });
}

function page(vm, ctx) {
  const actions = [
    vm.sshCommand ? button({ label: 'Open SSH', kind: 'secondary', icon: 'out', attrs: { 'data-action': 'ssh' } }) : '',
    ctx.can('draft') && vm.can.stop ? button({ label: 'Stop', kind: 'secondary', attrs: { 'data-action': 'stop' } }) : '',
    ctx.can('draft') && vm.can.start ? button({ label: 'Start', kind: 'secondary', attrs: { 'data-action': 'start' } }) : '',
    vm.role !== 'database' ? button({ label: 'Deploy an app', icon: 'repo', href: hrefFor(ctx, `/apps/new?vm=${encodeURIComponent(vm.name)}`) }) : '',
  ];
  const facts = [vm.zone, vm.machineType, vm.image, vm.uptimeText].filter(Boolean).join(' · ');
  return html`${crumbs(ctx, [['Virtual machines', '/vms'], [vm.name]])}
    ${pageHead({ title: vm.name, actions: html`${actions}` })}
    <p class="inf-meta">${statusPill({ text: vm.statusText, tone: vm.tone })}${cloudBadge(vm.cloud)}<span>${facts}</span></p>
    ${messageRegion()}
    <div data-region="ssh" hidden>${card({ title: 'Connect over SSH', body: html`<p class="inf-muted">From a terminal on a computer that holds the VM’s key (${vm.sshKey ?? 'its SSH key'}), and from an address SSH is open to (${vm.ports.split(' · ')[0]}):</p>${copyField(vm.sshCommand ?? '', { label: 'Copy the SSH command' })}` })}</div>
    ${vm.failure ? notice({ title: 'The last operation failed', text: vm.failure, tone: 'error' }) : ''}
    ${vm.operation ? operationCard(vm.operation, ctx) : ''}
    ${vm.role === 'database' ? notice({ title: `This VM runs the database ${vm.ownedBy}`, text: 'Start, stop, resize and delete it from Databases.', tone: 'muted', iconName: 'info' }) : ''}
    <section class="inf-stats" aria-label="Health" data-region="health">${healthTiles(null)}</section>
    ${endpointsCard(vm, ctx)}
    ${card({
      title: 'Apps on this VM',
      meta: 'Built from a Dockerfile in Git and run as containers',
      body: vm.apps.length ? dataTable({
        caption: 'Apps on this VM',
        rows: vm.apps,
        columns: [
          { key: 'name', label: 'App', render: (a) => html`<a class="inf-strong-link" href="${hrefFor(ctx, `/apps/${a.name}`)}">${a.name}</a>${a.deployedAt ? html`<span class="inf-sub">Deployed ${ago(a.deployedAt)}</span>` : ''}` },
          { key: 'repo', label: 'Repository', render: (a) => html`<span class="inf-mono">${a.repo}</span><span class="inf-sub">${a.branch} · ${a.dockerfile}</span>` },
          { key: 'commit', label: 'Commit', render: (a) => html`<span class="inf-mono">${a.commit ?? '—'}</span>` },
          { key: 'status', label: 'Status', render: (a) => statusPill({ text: APP_STATUS[a.status]?.[0] ?? a.status, tone: APP_STATUS[a.status]?.[1] ?? 'neutral' }) },
          { key: 'auto', label: 'Auto-deploy', render: (a) => a.autoDeploy },
        ],
      }) : html`<p class="inf-muted">No apps yet. Deploy one from Git: it is built here and run as a container.</p>`,
    })}
    ${vm.latestDeploy ? latestDeployCard(vm.latestDeploy, ctx) : ''}
    <div class="inf-pair">
      ${card({
        title: 'Details',
        body: kv([
          ['Public IP', vm.publicIp ? html`<span class="inf-mono">${vm.publicIp}${vm.staticIp ? ' · static' : ''}</span>` : vm.publicIpText],
          ['Private IP', vm.privateIp ? html`<span class="inf-mono">${vm.privateIp}</span>` : '—'],
          ['SSH', vm.sshCommand ? copyField(vm.sshCommand, { label: 'Copy the SSH command' }) : '—'],
          ['SSH key', vm.sshKey ?? '—'],
          ['Open ports', vm.ports],
          ['Runtime', vm.runtime ?? '—'],
          ['Account', html`${vm.cloudLabel} · ${vm.accountLabel}`],
          ['Created', `${new Date(vm.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}${vm.createdBy ? ` by ${vm.createdBy.name}` : ''}`],
          ['Est. cost', `${usd(vm.estimate.monthly)} / month${vm.estimate.note ? ` (${vm.estimate.note})` : ''}`],
        ]),
      })}
      ${card({
        title: 'Recent work',
        body: vm.operations.length ? html`<ul class="inf-feed">${vm.operations.map((op) => html`<li class="inf-feed__row">${statusPill({ text: op.statusText, tone: op.tone, dot: false })}<span class="inf-feed__text">${op.label}${op.error ? html`<span class="inf-sub">${op.error.message}</span>` : ''}</span><time class="inf-feed__when" datetime="${op.createdAt}">${ago(op.createdAt)}</time></li>`)}</ul>`
          : html`<p class="inf-muted">Nothing done here through Noobly Cloud yet.</p>`,
      })}
    </div>
    ${vm.role !== 'database' && (ctx.can('draft') || ctx.can('approve')) ? card({
      title: 'Danger zone',
      body: html`<div class="actions">${ctx.can('draft') && vm.can.restart ? button({ label: 'Restart', kind: 'secondary', attrs: { 'data-action': 'restart' } }) : ''}${ctx.can('approve') && vm.can.delete ? button({ label: 'Delete VM', kind: 'danger', attrs: { 'data-action': 'delete' } }) : ''}</div>
        <p class="inf-muted">Deleting removes the machine, its disk and its address in the cloud. A VM with apps can’t be deleted until they are.</p>`,
    }) : ''}`;
}

export async function render(view, { params, ctx }) {
  const name = params.name;
  const api = (path) => `vms/${encodeURIComponent(name)}${path}`;
  let vm = null;
  let health = null;

  const drawHealth = () => {
    const region = view.querySelector('[data-region="health"]');
    if (region) region.innerHTML = String(healthTiles(health));
  };
  const loadHealth = async () => {
    if (!vm || vm.role === 'database' && vm.status !== 'running') return;
    try {
      health = await ctx.api.get(api('/health'));
      if (ctx.isCurrent()) drawHealth();
    } catch (err) {
      if (!isAbort(err)) health = { problem: `Health could not be read: ${err.message}` };
      drawHealth();
    }
  };

  /** Puts an endpoint form (new, or one being changed) under the endpoints table. */
  const showForm = (form) => {
    const region = view.querySelector('[data-region="endpoint-form"]');
    if (!region) return null;
    if (typeof form === 'string') region.innerHTML = String(form);
    else region.replaceChildren(form);
    region.hidden = false;
    const add = view.querySelector('[data-region="endpoint-add"]');
    if (add) add.hidden = true;
    const el = region.querySelector('form');
    syncEndpointForm(el);
    return el;
  };
  const closeForm = () => {
    const region = view.querySelector('[data-region="endpoint-form"]');
    if (region) {
      region.replaceChildren();
      region.hidden = true;
    }
    const add = view.querySelector('[data-region="endpoint-add"]');
    if (add) add.hidden = false;
  };

  const redraw = await reloadable(view, ctx, async () => {
    try {
      vm = await ctx.api.get(api(''));
    } catch (err) {
      if (!isAbort(err)) view.innerHTML = String(err.status === 404 ? notice({ title: `No VM called ${name}`, text: 'It may have been deleted.', tone: 'muted', actions: button({ label: 'All VMs', href: hrefFor(ctx, '/vms') }), headingLevel: 1 }) : errorCard(err, name));
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    const sshOpen = !view.querySelector('[data-region="ssh"]')?.hidden;
    // An endpoint form being filled in is moved into the new page as it is: what was typed, and the focus.
    const kept = view.querySelector('[data-form="endpoint"]');
    const active = kept?.contains(view.ownerDocument.activeElement) ? view.ownerDocument.activeElement : null;
    view.innerHTML = String(page(vm, ctx));
    if (sshOpen && vm.sshCommand) view.querySelector('[data-region="ssh"]').hidden = false;
    if (kept && (kept.dataset.id ? vm.endpoints.some((e) => e.id === kept.dataset.id && e.can.change) : canAddEndpoint(vm, ctx))) {
      showForm(kept);
      active?.focus();
    }
    drawHealth();
    return vm.operation ? REFRESH_MS : 0;
  });
  loadHealth();

  wireCopy(view, ctx.signal, (text, tone) => say(view, text, tone));
  view.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target || target.dataset.action === 'reload') return;
    const { action } = target.dataset;
    if (action === 'ssh') {
      const panel = view.querySelector('[data-region="ssh"]');
      panel.hidden = !panel.hidden;
      return;
    }
    if (action === 'endpoint-add' || action === 'endpoint-edit') {
      const e = action === 'endpoint-edit' ? vm.endpoints.find((x) => x.id === target.dataset.id) : null;
      const form = showForm(String(endpointForm({ vm, e })));
      form?.querySelector(e ? '[name="port"]' : '[name="address"]:checked')?.focus();
      return;
    }
    if (action === 'endpoint-cancel') {
      closeForm();
      view.querySelector('[data-action="endpoint-add"]')?.focus();
      return;
    }
    try {
      target.disabled = true;
      if (action === 'cancel') {
        await ctx.api.post(`operations/${encodeURIComponent(target.dataset.id)}/cancel`);
        say(view, 'Cancelled.', 'success');
      } else if (['start', 'stop', 'restart'].includes(action)) {
        await ctx.api.post(api(`/${action}`));
        say(view, `${action === 'stop' ? 'Stopping' : action === 'start' ? 'Starting' : 'Restarting'} ${name}.`, 'success');
      } else if (action === 'endpoint-remove') {
        const e = vm.endpoints.find((x) => x.id === target.dataset.id);
        if (!e) return;
        const last = vm.endpoints.filter((x) => x.host === e.host).length === 1;
        const ok = await confirmDialog(view, {
          title: `Remove ${where(e)}?`,
          text: `${last ? `${e.host} stops being served` : `${where(e)} stops being served; ${e.host}’s other paths carry on`}.${vm.endpoints.length === 1 ? ' Ports 80 and 443 close.' : ''}`,
          confirmLabel: 'Remove endpoint',
        });
        if (!ok) return;
        await ctx.api.del(`endpoints/${encodeURIComponent(e.id)}`);
        say(view, `Removing ${where(e)}.`, 'success');
      } else if (action === 'delete') {
        const ok = await confirmDialog(view, { title: `Delete ${name}?`, text: 'The machine, its disk and its address are deleted in the cloud. This can’t be undone.', confirmLabel: 'Delete VM', typeToConfirm: name });
        if (!ok) return;
        await ctx.api.del(api(''), { body: { confirm: name } });
        say(view, `Deleting ${name}.`, 'success');
      }
      health = null;
      await redraw();
      loadHealth();
    } catch (err) {
      if (!isAbort(err)) say(view, err.message, 'error');
    } finally {
      target.disabled = false;
    }
  }, { signal: ctx.signal });

  view.addEventListener('change', (event) => {
    const form = event.target.closest?.('[data-form="endpoint"]');
    if (form) syncEndpointForm(form);
  }, { signal: ctx.signal });

  view.addEventListener('submit', async (event) => {
    const form = event.target.closest?.('[data-form="endpoint"]');
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showFieldErrors(form, {});
    try {
      const body = endpointBody(formValues(form));
      const result = form.dataset.id
        ? await ctx.api.patch(`endpoints/${encodeURIComponent(form.dataset.id)}`, body)
        : await ctx.api.post(api('/endpoints'), body);
      closeForm();
      say(view, `${form.dataset.id ? 'Changing' : 'Adding'} ${where(result.endpoint)}.`, 'success');
      await redraw();
    } catch (err) {
      if (isAbort(err)) return;
      if (err.details?.fields) showFieldErrors(form, err.details.fields);
      else showFieldErrors(form, { address: err.message });
      submit.disabled = false;
    }
  }, { signal: ctx.signal });
}
