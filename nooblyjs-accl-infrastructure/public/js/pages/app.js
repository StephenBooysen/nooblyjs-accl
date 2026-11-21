// App detail (no mockup; product.md §6.11; roadmap 6.7): where the app runs and how, its environment (secret values
// never shown), the deploy in progress with its steps and log, every deploy with its log, the container's output, and
// Redeploy, Stop, Start and Delete. Data: GET /apps/:name, /apps/:name/deploys/:id, /apps/:name/logs, /operations/:id.
import { pageHead, statusPill, dataTable, card, notice } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { html, button, hrefFor, crumbs, errorCard, isAbort, reloadable, say, messageRegion, progressBar, REFRESH_MS } from '../lib.js';
import { cloudBadge, kv, confirmDialog } from '../components/index.js';

const STEP = { pending: 'Waiting', running: 'Running', done: 'Done', skipped: 'Skipped', failed: 'Failed' };
const DEPLOY = { queued: ['Queued', 'neutral'], building: ['Building', 'warning'], deploying: ['Deploying', 'warning'], live: ['Live', 'success'], failed: ['Failed', 'danger'], cancelled: ['Cancelled', 'neutral'] };
const RESTART = { always: 'Always', 'on-failure': 'On failure', never: 'Never' };
const time = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '');

/** A log as lines with their time: [{ at, text }] or the raw text of a deploy record. */
export function logBlock(lines, { label, id } = {}) {
  const rows = typeof lines === 'string' ? lines.split('\n').filter(Boolean).map((l) => ({ at: l.slice(0, 24), text: l.slice(26) })) : lines;
  if (!rows.length) return html`<p class="inf-muted">Nothing logged yet.</p>`;
  return html`<pre class="inf-log"${id ? html` id="${id}"` : ''} tabindex="0" aria-label="${label ?? 'Log'}">${rows.map((r) => html`<span class="inf-log__line"><span class="inf-log__at">${time(r.at)}</span>${r.text}</span>\n`)}</pre>`;
}

function deployCard(op, ctx) {
  return card({
    title: html`<span id="deploy-log">Deploying ${op.label?.replace(/^Deploy /, '') ?? ''}</span>`,
    meta: op.statusText,
    body: html`${progressBar(op.statusText, op.progress)}
      <ol class="inf-steps">${op.steps.map((s) => html`<li class="inf-steps__step inf-steps__step--${s.status}"><span class="inf-steps__label">${s.label}</span><span class="inf-sub">${s.reason ?? STEP[s.status] ?? s.status}</span></li>`)}</ol>
      ${logBlock(op.log ?? [], { label: 'Deploy log' })}
      ${op.cancellable && ctx.can('draft') ? html`<div class="actions">${button({ label: 'Cancel deploy', kind: 'secondary', small: true, attrs: { 'data-action': 'cancel', 'data-id': op.id } })}</div>` : ''}`,
  });
}

function envTable(app, ctx) {
  return dataTable({
    caption: 'Environment variables',
    empty: 'No environment variables.',
    rows: app.run.env,
    columns: [
      { key: 'key', label: 'Name', render: (e) => html`<span class="inf-mono">${e.key}</span>` },
      {
        key: 'value',
        label: 'Value',
        render: (e) => (e.kind === 'plain' ? html`<span class="inf-mono">${e.value}</span>`
          : e.kind === 'secret' ? html`<span class="inf-muted">Secret · hidden</span>`
            : html`Linked to <a href="${hrefFor(ctx, `/${e.kind === 'database' ? 'databases' : 'buckets'}/${e.target}`)}">${e.target}</a><span class="inf-sub">${e.kind === 'database' ? 'Its connection string, set at each deploy' : 'Its name, with access keys when the app has them'}</span>`),
      },
    ],
  });
}

function deploysTable(app, ctx) {
  return dataTable({
    caption: 'Deploys',
    empty: 'No deploys yet.',
    rows: app.deploys,
    columns: [
      { key: 'when', label: 'Started', render: (d) => html`<time datetime="${d.startedAt}">${ago(d.startedAt)}</time>${d.endedAt ? html`<span class="inf-sub">${Math.max(0, Math.round((Date.parse(d.endedAt) - Date.parse(d.startedAt)) / 1000))} s</span>` : ''}` },
      { key: 'commit', label: 'Commit', render: (d) => html`<span class="inf-mono">${d.commit ?? '—'}</span>${d.message ? html`<span class="inf-sub">${d.message}</span>` : ''}` },
      { key: 'by', label: 'By', render: (d) => (d.trigger === 'push' ? html`Push<span class="inf-sub">${d.by?.name ?? ''}</span>` : d.by?.name ?? '—') },
      { key: 'status', label: 'Status', render: (d) => html`${statusPill({ text: (DEPLOY[d.status] ?? [d.status])[0], tone: (DEPLOY[d.status] ?? [null, 'neutral'])[1] })}${d.reason ? html`<span class="inf-sub">${d.reason}</span>` : ''}` },
      { key: 'log', label: html`<span class="visually-hidden">Log</span>`, render: (d) => (d.hasLog || d.operation ? button({ label: 'View log', kind: 'secondary', small: true, attrs: { 'data-action': 'deploy-log', 'data-id': d.id, 'aria-label': `View the log of the deploy started ${ago(d.startedAt)}` } }) : '') },
    ],
  });
}

function detailsCard(app, ctx) {
  const e = app.endpoint;
  return card({
    title: 'Where it runs',
    body: kv([
      ['VM', html`<span class="inf-inline">${app.cloud ? cloudBadge(app.cloud) : ''}<a class="inf-mono" href="${hrefFor(ctx, `/vms/${app.vm}`)}">${app.vm}</a>${app.region ? html` · ${app.region}` : ''}</span>`],
      ['Endpoint', e ? html`${e.live && e.url ? html`<a class="inf-mono" href="${e.url}" rel="noopener">${e.url}</a>` : html`<span class="inf-mono">${e.host}${e.path !== '/' ? e.path : ''}</span>`}${e.note ? html`<span class="inf-sub">${e.note}</span>` : ''}` : 'Private · no endpoint'],
      ['Source', html`<span class="inf-mono">${app.repo}</span><span class="inf-sub">${app.branch} · ${app.source.dockerfile}${app.source.context !== '.' ? ` · context ${app.source.context}` : ''}${app.source.gitConnection ? ` · via ${app.source.gitConnection}` : ' · public'}</span>`],
      ['Running', app.current ? html`<span class="inf-mono">${app.current.commit}</span>${app.current.message ? ` ${app.current.message}` : ''}<span class="inf-sub">Deployed ${ago(app.current.deployedAt)} ${app.lastDeploy?.by ?? ''}</span>` : 'Nothing yet'],
      ['Container', `${app.run.port ? `Port ${app.run.port}` : 'No port'} · restarts ${(RESTART[app.run.restart] ?? app.run.restart).toLowerCase()}${app.current?.hostPort ? ` · 127.0.0.1:${app.current.hostPort} on the VM` : ''}`],
      ['Health check', app.healthCheck ? html`<span class="inf-mono">GET ${app.healthCheck}</span> must return 200` : 'The container must keep running'],
      ['Auto-deploy', app.autoDeploy ? html`On push to ${app.branch}${app.webhook?.state !== 'active' ? html`<span class="inf-sub inf-tone inf-tone--warning">${app.webhook?.problem ?? 'The webhook is not set up.'}</span>` : ''}` : 'Off'],
    ]),
  });
}

export async function render(view, { params, ctx }) {
  const name = params.name;
  view.innerHTML = String(html`${crumbs(ctx, [['Apps', '/apps'], [name]])}<div data-region="head">${pageHead({ title: name, lead: ' ' })}</div>${messageRegion()}<div data-region="body"><p class="inf-muted">Loading…</p></div>`);
  const head = view.querySelector('[data-region="head"]');
  const region = view.querySelector('[data-region="body"]');
  let app = null;
  const openLogs = new Set();

  const redraw = await reloadable(region, ctx, async () => {
    let op = null;
    try {
      app = await ctx.api.get(`apps/${encodeURIComponent(name)}`);
      if (app.operation) op = await ctx.api.get(`operations/${encodeURIComponent(app.operation.id)}`);
    } catch (err) {
      if (isAbort(err)) return 0;
      region.innerHTML = String(err.status === 404 ? notice({ title: `No app ${name}`, text: 'It may have been deleted.', tone: 'muted', actions: button({ label: 'All apps', href: hrefFor(ctx, '/apps') }) }) : errorCard(err, name));
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    const may = ctx.can('draft');
    const actions = html`${may && app.can.redeploy ? button({ label: 'Redeploy', icon: 'repo', attrs: { 'data-action': 'redeploy' } }) : ''}${may && app.can.stop ? button({ label: 'Stop', kind: 'secondary', attrs: { 'data-action': 'stop' } }) : ''}${may && app.can.start ? button({ label: 'Start', kind: 'secondary', attrs: { 'data-action': 'start' } }) : ''}${may && app.can.startVm ? button({ label: 'Start VM', kind: 'secondary', attrs: { 'data-action': 'start-vm' } }) : ''}`;
    head.innerHTML = String(pageHead({ title: app.name, lead: html`<span class="inf-inline">${statusPill({ text: app.statusText, tone: app.tone })}<span>${app.repo} @ ${app.branch} · on ${app.vm}</span></span>`, actions }));
    region.innerHTML = String(html`
      ${app.problem ? notice({ title: 'Needs attention', text: app.problem, tone: 'warning' }) : ''}
      ${app.failure && app.status !== 'live' ? notice({ title: app.status === 'crashed' ? 'The container stopped' : 'The last deploy failed', text: app.failure.reason, tone: 'error' }) : ''}
      ${app.failure && app.status === 'live' && app.deploys[0]?.status === 'failed' ? notice({ title: 'The last deploy failed; the previous version is serving', text: app.failure.reason, tone: 'warning' }) : ''}
      ${op && op.type === 'app.deploy' ? deployCard(op, ctx) : op ? notice({ title: op.statusText, text: op.label, tone: 'muted', iconName: 'clock' }) : ''}
      <div class="inf-pair">${detailsCard(app, ctx)}${card({ title: 'Environment variables', meta: 'Secret values are never shown', body: envTable(app, ctx) })}</div>
      ${card({ title: 'Deploys', meta: `The last ${app.deploys.length}`, body: html`${deploysTable(app, ctx)}<div data-region="deploy-log"></div>` })}
      ${card({ title: 'Logs', meta: 'The container’s output (docker logs)', body: html`<div data-region="logs"><p class="inf-muted">The last lines the running container wrote.</p>${app.current ? button({ label: 'Show the last 200 lines', kind: 'secondary', small: true, attrs: { 'data-action': 'logs' } }) : ''}</div>` })}
      ${ctx.can('approve') ? card({ title: 'Danger zone', body: html`<p class="inf-muted">Deleting removes the app’s containers and images from ${app.vm}, its endpoint and its webhook. The VM and the repository stay.</p>${button({ label: 'Delete app', kind: 'secondary', attrs: { 'data-action': 'delete' } })}` }) : ''}`);
    for (const id of openLogs) showDeployLog(id).catch(() => {});
    return app.operation ? REFRESH_MS : 0;
  });

  async function showDeployLog(id) {
    const d = await ctx.api.get(`apps/${encodeURIComponent(name)}/deploys/${encodeURIComponent(id)}`);
    const slot = region.querySelector('[data-region="deploy-log"]');
    if (!slot) return;
    openLogs.clear();
    openLogs.add(id);
    slot.innerHTML = String(html`<h3 class="inf-h">Log of ${d.commit ?? 'the deploy'} · ${(DEPLOY[d.status] ?? [d.status])[0]}</h3>${logBlock(d.log, { label: `Log of the deploy ${d.id}` })}`);
  }

  view.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target || target.dataset.action === 'reload') return;
    const { action, id } = target.dataset;
    target.disabled = true;
    try {
      if (action === 'deploy-log') return await showDeployLog(id);
      if (action === 'logs') {
        const out = await ctx.api.get(`apps/${encodeURIComponent(name)}/logs`, { query: { lines: 200 } });
        region.querySelector('[data-region="logs"]').innerHTML = String(out.lines.length
          ? html`<pre class="inf-log" tabindex="0" aria-label="Container output">${out.lines.map((l) => html`<span class="inf-log__line">${l}</span>\n`)}</pre>${button({ label: 'Refresh', kind: 'secondary', small: true, attrs: { 'data-action': 'logs' } })}`
          : html`<p class="inf-muted">${out.note ?? 'Nothing written yet.'}</p>`);
        return undefined;
      }
      if (action === 'redeploy') {
        await ctx.api.post(`apps/${encodeURIComponent(name)}/deploy`);
        say(view, `Redeploying ${name} from the latest commit on ${app.branch}.`, 'success');
      } else if (action === 'stop' || action === 'start') {
        await ctx.api.post(`apps/${encodeURIComponent(name)}/${action}`);
        say(view, `${action === 'stop' ? 'Stopping' : 'Starting'} ${name}.`, 'success');
      } else if (action === 'start-vm') {
        await ctx.api.post(`vms/${encodeURIComponent(app.vm)}/start`);
        say(view, `Starting ${app.vm}.`, 'success');
      } else if (action === 'cancel') {
        await ctx.api.post(`operations/${encodeURIComponent(id)}/cancel`);
        say(view, 'Cancelling the deploy. The version serving now keeps serving.', 'success');
      } else if (action === 'delete') {
        const ok = await confirmDialog(view, {
          title: `Delete ${name}?`,
          text: `Its containers and images on ${app.vm}, its endpoint and its webhook are removed. This can’t be undone.`,
          confirmLabel: 'Delete app',
          typeToConfirm: name,
        });
        if (!ok) return undefined;
        await ctx.api.del(`apps/${encodeURIComponent(name)}`, { body: { confirm: name } });
        say(view, `Deleting ${name}.`, 'success');
      }
      await redraw();
    } catch (err) {
      if (!isAbort(err)) say(view, err.message, 'error');
    } finally {
      target.disabled = false;
    }
    return undefined;
  }, { signal: ctx.signal });
}
