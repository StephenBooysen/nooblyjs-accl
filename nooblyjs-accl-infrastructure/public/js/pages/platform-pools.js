// Host pools (spec 8.2.1; no mockup yet, so kit components only): the Platform page's section for the shared VMs a cloud
// region's instances run on. Create a pool (account, region, size, min and max hosts); each pool's hosts with their
// agent's status, what is reserved against what they can hold, and how many instances; Add a host; Drain a host (its
// instances move one at a time, then the VM is deleted); Delete an empty pool. Operators only (the Platform page checks
// change-guardrails). Then each region's ingress (spec 8.4.1): its addresses, the last sync to its VMs, the platform
// domain's certificate, and custom domains waiting for their DNS. Data: GET /platform/pools, /platform/ingress,
// /accounts, /catalog?cloud=.
import { notice, statusPill, dataTable, card } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { confirmDialog, field, describedBy, kv } from '../components/index.js';
import { html, button, isAbort, errorCard, reloadable, say } from '../lib.js';
import { formValues, showFieldErrors } from '../forms.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const memory = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const PURPOSE = { host: 'Hosts', builder: 'Builders', ingress: 'Ingress' };
const TONE = { Online: 'success', Offline: 'danger', Enrolling: 'info', Starting: 'info', Draining: 'warning' };
const options = (items, value) => items.map(([v, label]) => html`<option value="${v}"${v === value ? html` selected` : ''}>${label}</option>`);

function poolForm(accounts, regions) {
  return html`<form class="card inf-form" data-form="pool" novalidate aria-labelledby="inf-pool-h">
    <h2 class="card__title" id="inf-pool-h">Create a host pool</h2>
    <div class="inf-form__row">
      ${field({ name: 'name', label: 'Pool name', control: html`<input class="inf-input inf-mono" name="name" required autocomplete="off" spellcheck="false" placeholder="web"${describedBy('name')}>`, help: 'Its hosts are named after it: web-1, web-2.' })}
      ${field({ name: 'purpose', label: 'Runs', control: html`<select class="inf-input" name="purpose"${describedBy('purpose')}>${options([['host', 'Instances (hosts)'], ['builder', 'Builds'], ['ingress', 'Ingress']], 'host')}</select>` })}
    </div>
    <div class="inf-form__row">
      ${field({ name: 'account', label: 'Cloud account', control: html`<select class="inf-input" name="account"${describedBy('account')}>${options(accounts.map((a) => [a.id, `${a.cloudLabel} · ${a.label}`]), accounts[0]?.id)}</select>` })}
      ${field({ name: 'region', label: 'Region', control: html`<select class="inf-input" name="region" data-regions${describedBy('region')}>${options(regions.map((r) => [r.id, `${r.id} · ${r.label}`]), accounts[0]?.defaultRegion)}</select>` })}
      ${field({ name: 'size', label: 'Host size', control: html`<select class="inf-input" name="size"${describedBy('size')}>${options([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'medium')}</select>`, help: 'Each host keeps 0.25 vCPU and 512 MB for the system and the agent.' })}
    </div>
    <div class="inf-form__row">
      ${field({ name: 'min', label: 'Fewest hosts', control: html`<input class="inf-input" name="min" type="number" min="0" max="20" step="1" value="1" inputmode="numeric"${describedBy('min')}>`, help: 'Launched now.' })}
      ${field({ name: 'max', label: 'Most hosts', control: html`<input class="inf-input" name="max" type="number" min="1" max="50" step="1" value="3" inputmode="numeric"${describedBy('max')}>`, help: 'The pool grows to this when the region is full; past it, deploys say “Region … is full”.' })}
    </div>
    <div class="actions">${button({ label: 'Create pool', type: 'submit' })}${button({ label: 'Cancel', kind: 'secondary', attrs: { 'data-action': 'pool-close' } })}</div>
  </form>`;
}

const reservedText = (h) => (h.allocatable
  ? html`${h.reserved.cpu} / ${h.allocatable.cpu} vCPU<span class="inf-sub">${memory(h.reserved.memoryMb)} / ${memory(h.allocatable.memoryMb)}</span>`
  : html`<span class="inf-muted">—</span>`);

function poolCard(p) {
  const hosts = p.hosts.length ? dataTable({
    caption: `Hosts of pool ${p.name}`,
    rows: p.hosts,
    columns: [
      { key: 'vm', label: 'Host', render: (h) => html`<strong class="inf-mono">${h.vm}</strong>${h.privateIp ? html`<span class="inf-sub inf-mono">${h.privateIp}</span>` : ''}` },
      { key: 'status', label: 'Status', render: (h) => html`${statusPill({ text: h.statusText, tone: TONE[h.statusText] ?? 'neutral' })}${h.warnings.map((w) => html`<span class="inf-sub">${w}</span>`)}` },
      { key: 'reserved', label: 'Reserved / can hold', render: reservedText },
      { key: 'instances', label: 'Instances', numeric: true, render: (h) => String(h.instances) },
      { key: 'actions', label: 'Actions', render: (h) => (h.draining || h.status !== 'running' ? '' : button({ label: 'Drain', kind: 'secondary', small: true, attrs: { 'data-action': 'host-drain', 'data-vm': h.vm, 'aria-label': `Drain ${h.vm}` } })) },
    ],
  }) : html`<p class="inf-muted">No hosts yet.</p>`;
  return card({
    label: `Pool ${p.name}`,
    title: p.name,
    meta: `${PURPOSE[p.purpose] ?? p.purpose} · ${p.region} · ${p.account} · ${p.machineType} · ${p.min}–${p.max} hosts · ${p.online} online${p.growing ? ` · adding ${plural(p.growing, 'host')}` : ''}`,
    body: html`${hosts}<div class="actions">${p.can.grow ? button({ label: 'Add a host', small: true, attrs: { 'data-action': 'pool-grow', 'data-pool': p.name } }) : ''}${p.can.delete ? button({ label: 'Delete pool', kind: 'secondary', small: true, attrs: { 'data-action': 'pool-delete', 'data-pool': p.name } }) : ''}</div>`,
  });
}

function ingressCard(r) {
  const domains = r.domains.length ? dataTable({
    caption: `Custom domains in ${r.region}`,
    rows: r.domains,
    columns: [
      { key: 'host', label: 'Domain', render: (d) => html`<span class="inf-mono">${d.host}</span>` },
      { key: 'workload', label: 'Service', render: (d) => `${d.workload} (${d.tenantId})` },
      { key: 'status', label: 'Status', render: (d) => statusPill(d.status === 'verified' ? { text: 'Verified', tone: 'success' } : { text: 'Waiting for DNS', tone: 'warning' }) },
      { key: 'expect', label: 'Point it at', render: (d) => (d.status === 'verified' ? '' : html`<span class="inf-mono">${(d.expect ?? []).join(', ') || '—'}</span>`) },
    ],
  }) : '';
  const s = r.state;
  return card({
    label: `Ingress ${r.region}`,
    title: `Ingress · ${r.region}`,
    meta: `${plural(r.online, 'VM')} online${r.platformDomain ? ` · *.${r.platformDomain}` : ''}`,
    body: html`${kv([
      ['Addresses', r.addresses.length ? html`<span class="inf-mono">${r.addresses.join(', ')}</span>` : 'None yet'],
      ['Platform domain', r.platformDomain ? (r.wildcard ? `*.${r.platformDomain}, wildcard certificate by DNS-01` : r.platformDomain) : 'Not set (INFRA_PLATFORM_DOMAIN)'],
      ['Last sync', s?.syncedAt ? html`<time datetime="${s.syncedAt}">${ago(s.syncedAt)}</time>, ${plural(s.sites, 'site')} to ${s.servers.join(', ')}` : 'Not yet'],
      ['Problem', s?.error ? html`<span class="inf-tone inf-tone--danger">${s.error}</span>` : null],
    ])}${domains}`,
  });
}

/** Draws the Host pools section into `region`; `view` holds the page's message line. */
export async function renderPools(view, region, ctx) {
  region.innerHTML = String(html`<section aria-labelledby="inf-pools-h">
    <div class="page-head"><h2 class="card__title" id="inf-pools-h">Host pools</h2>
      <div class="actions">${button({ label: 'Create pool', kind: 'secondary', small: true, attrs: { 'data-action': 'pool-open' } })}</div></div>
    <div data-region="pool-form" hidden></div>
    <div data-region="pools"></div>
  </section>`);
  const formRegion = region.querySelector('[data-region="pool-form"]');
  const list = region.querySelector('[data-region="pools"]');
  const tell = (text, tone) => say(view, text, tone);
  let accounts = [];

  const redraw = await reloadable(list, ctx, async () => {
    let data;
    try {
      data = await ctx.api.get('platform/pools');
    } catch (err) {
      if (isAbort(err)) return 0;
      list.innerHTML = String(err?.status === 404
        ? notice({ title: 'No host pools here', text: 'Host pools need the platform layer and agents (the launcher passes WebSocket upgrades).', tone: 'muted', iconName: 'info' })
        : errorCard(err, 'host pools'));
      region.querySelector('[data-action="pool-open"]')?.setAttribute('hidden', '');
      return 0;
    }
    const ingress = await ctx.api.get('platform/ingress').then((x) => x.regions, () => []);
    if (!ctx.isCurrent()) return 0;
    list.innerHTML = String(data.pools.length
      ? html`${data.pools.map(poolCard)}${ingress.map(ingressCard)}`
      : notice({ title: 'No host pools yet', text: 'A host pool is a set of VMs in one cloud region that run tenants’ instances side by side, each with its own limits. Until a region has one, its instances run on the mock runtime.', tone: 'muted', iconName: 'info' }));
    return data.pools.some((p) => p.growing || p.hosts.some((h) => h.status !== 'running' || h.statusText === 'Enrolling' || h.draining)) ? 2000 : 0;
  });

  const regionsOf = async (accountId) => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? (await ctx.api.get(`catalog?cloud=${encodeURIComponent(a.cloud)}`)).regions : [];
  };
  const closeForm = () => {
    formRegion.hidden = true;
    formRegion.replaceChildren();
  };

  region.addEventListener('change', async (event) => {
    if (event.target.name !== 'account' || !event.target.closest('[data-form="pool"]')) return;
    const regions = await regionsOf(event.target.value).catch(() => []);
    const a = accounts.find((x) => x.id === event.target.value);
    formRegion.querySelector('[data-regions]').innerHTML = String(html`${options(regions.map((r) => [r.id, `${r.id} · ${r.label}`]), a?.defaultRegion)}`);
  }, { signal: ctx.signal });

  region.addEventListener('submit', async (event) => {
    if (event.target.dataset.form !== 'pool') return;
    event.preventDefault();
    const v = formValues(event.target);
    const body = { ...v, min: Number(v.min), max: Number(v.max) };
    const submit = event.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const { pool, operations } = await ctx.api.post('platform/pools', body);
      closeForm();
      tell(`Created pool ${pool.name}${operations.length ? `; launching ${plural(operations.length, 'host')}` : ''}.`, 'success');
      await redraw();
    } catch (err) {
      if (isAbort(err)) return;
      if (err.details?.fields) showFieldErrors(formRegion, err.details.fields);
      else tell(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }, { signal: ctx.signal });

  region.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target) return undefined;
    const { action } = target.dataset;
    if (action === 'pool-close') return closeForm();
    try {
      if (action === 'pool-open') {
        accounts = (await ctx.api.get('accounts')).accounts.filter((a) => a.cloud === 'gcp' || a.cloud === 'aws');
        if (!accounts.length) return tell('Connect a GCP or AWS account first: a pool’s hosts are VMs in it.', 'error');
        formRegion.innerHTML = String(poolForm(accounts, await regionsOf(accounts[0].id)));
        formRegion.hidden = false;
        formRegion.querySelector('input[name="name"]').focus();
        return undefined;
      }
      target.disabled = true;
      if (action === 'pool-grow') {
        await ctx.api.post(`platform/pools/${encodeURIComponent(target.dataset.pool)}/hosts`);
        tell(`Adding a host to ${target.dataset.pool}.`, 'success');
      }
      if (action === 'host-drain') {
        const { vm } = target.dataset;
        const ok = await confirmDialog(view, {
          title: `Drain ${vm}?`,
          text: 'Its instances move to the pool’s other hosts one at a time, each answering there before it stops here (the pool grows if it must). Then the VM is deleted.',
          confirmLabel: 'Drain and delete',
          typeToConfirm: vm,
        });
        if (!ok) return undefined;
        await ctx.api.post(`platform/hosts/${encodeURIComponent(vm)}/drain`);
        tell(`Draining ${vm}.`, 'success');
      }
      if (action === 'pool-delete') {
        const { pool } = target.dataset;
        const ok = await confirmDialog(view, { title: `Delete pool ${pool}?`, text: 'It has no hosts. Its region runs on the mock runtime again unless another pool serves it.', confirmLabel: 'Delete pool' });
        if (!ok) return undefined;
        await ctx.api.del(`platform/pools/${encodeURIComponent(pool)}`);
        tell(`Deleted pool ${pool}.`, 'success');
      }
      await redraw();
    } catch (err) {
      if (!isAbort(err)) tell(err.message, 'error');
    } finally {
      target.disabled = false;
    }
    return undefined;
  }, { signal: ctx.signal });
}
