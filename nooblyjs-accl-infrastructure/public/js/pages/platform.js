// Platform (spec 8.1, R8; no mockup yet, so kit components only): every tenant of the hosting launcher (NooblyJS Cloud's
// workspaces) and its workloads, read-only, for operators (change-guardrails). Tenants never see this screen; the
// launcher shows them their own workloads. Data: GET /platform (404 when the launcher has not turned the platform on).
import { pageHead, notice, statusPill, dataTable, card } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { html, errorCard, isAbort, reloadable, progressBar, REFRESH_MS } from '../lib.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const KIND = { service: 'Web service', private: 'Private service', worker: 'Worker', job: 'Job', static: 'Static site' };
const memory = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

function size(w) {
  if (w.kind === 'static') return html`<span class="inf-muted">Files only</span>`;
  const each = `${w.plan.cpu} vCPU · ${memory(w.plan.memoryMb)}`;
  return w.kind === 'job' ? html`${each}<span class="inf-sub">${w.schedule ? `Schedule ${w.schedule}` : 'On demand'}</span>` : html`${w.instances} × ${each}`;
}

function current(w) {
  if (!w.current) return html`<span class="inf-muted">Not deployed yet</span>`;
  return html`<span class="inf-mono">${w.current.commit ?? w.current.image}</span>${w.lastRun ? html`<span class="inf-sub">Last run ${w.lastRun.result} · <time datetime="${w.lastRun.at}">${ago(w.lastRun.at)}</time></span>` : ''}`;
}

function workloadTable(tenant) {
  return dataTable({
    caption: `Workloads of ${tenant.id}`,
    empty: 'No workloads.',
    rows: tenant.workloads,
    columns: [
      { key: 'name', label: 'Workload', render: (w) => html`<strong>${w.name}</strong><span class="inf-sub">${KIND[w.kind] ?? w.kind} · ${w.source?.repo ?? w.source?.image ?? ''}</span>` },
      { key: 'status', label: 'Status', render: (w) => (w.operation?.status === 'running' ? progressBar(w.operation.statusText, w.operation.progress) : statusPill({ text: w.statusText, tone: w.tone })) },
      { key: 'size', label: 'Reserved', render: size },
      { key: 'region', label: 'Region', render: (w) => w.region },
      { key: 'current', label: 'Running', render: current },
      { key: 'domains', label: 'Domains', render: (w) => (w.domains?.length ? html`${w.domains.map((d) => html`<span class="inf-mono">${d}</span> `)}` : html`<span class="inf-muted">${w.kind === 'private' ? 'Inside the tenant only' : '—'}</span>`) },
    ],
  });
}

const counts = (t) => ['live', 'deploying', 'failed', 'suspended'].filter((s) => t.counts[s]).map((s) => `${t.counts[s]} ${s}`).join(' · ');

export async function render(view, { ctx }) {
  if (!ctx.can('change-guardrails')) {
    view.innerHTML = String(html`${pageHead({ title: 'Platform', lead: 'Hosted workloads across tenants.' })}
      ${notice({ title: 'Operators only', text: 'The Platform screen needs the change-guardrails permission.', tone: 'muted', iconName: 'info' })}`);
    return;
  }
  view.innerHTML = String(html`${pageHead({ title: 'Platform', lead: 'Hosted workloads across tenants. Read-only: tenants change their own through the hosting product.' })}
    <div data-region="list"></div>`);
  const list = view.querySelector('[data-region="list"]');
  const lead = view.querySelector('.page-head .lead');

  await reloadable(list, ctx, async () => {
    let data;
    try {
      data = await ctx.api.get('platform');
    } catch (err) {
      if (isAbort(err)) return 0;
      list.innerHTML = String(err?.status === 404
        ? notice({ title: 'The platform layer is off', text: 'A hosting launcher turns it on with mount(…, { platform: { enabled: true } }).', tone: 'muted', iconName: 'info' })
        : errorCard(err, 'the platform'));
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    const { totals, tenants, capacity } = data;
    if (lead) lead.textContent = `${plural(totals.tenants, 'tenant')} · ${plural(totals.workloads, 'workload')} · ${totals.live} live`;
    list.innerHTML = String(html`${tenants.length ? tenants.map((t) => card({
      label: `Tenant ${t.id}`,
      title: t.id,
      meta: `${counts(t)} · reserves ${t.reserved.cpu} vCPU · ${memory(t.reserved.memoryMb)}`,
      body: workloadTable(t),
    })) : notice({ title: 'No workloads yet', text: 'Workloads appear here when the hosting launcher creates them.', tone: 'muted', iconName: 'info' })}
      ${card({
    label: 'Capacity',
    title: 'Capacity',
    body: html`${capacity.regions.length ? html`<ul class="inf-links">${capacity.regions.map((r) => html`<li>${r.region}: ${plural(r.instances, 'instance')} reserving ${r.reserved.cpu} vCPU · ${memory(r.reserved.memoryMb)}</li>`)}</ul>` : ''}<p class="inf-muted">${capacity.note}</p>`,
  })}`);
    return tenants.some((t) => t.counts.deploying || t.counts.deleting) ? REFRESH_MS : 0;
  });
}
