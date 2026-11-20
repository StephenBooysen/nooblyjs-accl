// Sites and servers (spec 8.9 R1, R2, R4, R12, R13; no mockup yet, so kit components only): the Platform page's section
// for local servers. Create a site; Add server shows a one-time enrolment token and the command that runs the agent
// with it (valid for an hour, shown once); each server's status, facts, warnings, reserved against allocatable and
// instances; Remove server. Operators only (the Platform page checks change-guardrails). Data: GET /platform/local
// (404 when the launcher cannot pass WebSocket upgrades, so there are no local servers).
import { notice, statusPill, dataTable, card, meter } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { kv, copyField, wireCopy, confirmDialog, field, describedBy } from '../components/index.js';
import { html, button, isAbort, errorCard, reloadable, say } from '../lib.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const memory = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const STATUS = { online: ['Online', 'success'], offline: ['Offline', 'danger'], enrolling: ['Enrolling', 'info'], removed: ['Removed', 'neutral'] };

function siteForm() {
  return html`<form class="card inf-form" data-form="site" novalidate aria-labelledby="inf-site-h">
    <h2 class="card__title" id="inf-site-h">Create a site</h2>
    <div class="inf-form__row">
      ${field({ name: 'id', label: 'Site id', control: html`<input class="inf-input inf-mono" name="id" required autocomplete="off" spellcheck="false" placeholder="lan-office"${describedBy('id')}>`, help: 'The region name services choose. Lower-case letters, numbers and hyphens.' })}
      ${field({ name: 'name', label: 'Name', control: html`<input class="inf-input" name="name" autocomplete="off" maxlength="60" placeholder="Office rack"${describedBy('name')}>`, help: 'What people see in the region list.' })}
      ${field({ name: 'bind', label: 'Bind address', control: html`<input class="inf-input inf-mono" name="bind" autocomplete="off" spellcheck="false" value="127.0.0.1"${describedBy('bind')}>`, help: '127.0.0.1 on one machine; 0.0.0.0 or a LAN address for a network. LAN only for now.' })}
    </div>
    <div class="inf-form__row">
      ${field({ name: 'reserve.cpu', label: 'Reserve per server (vCPU)', control: html`<input class="inf-input" name="reserve.cpu" type="number" min="0" max="16" step="0.05" value="0.25"${describedBy('reserve.cpu')}>`, help: 'Kept back for the system and the agent.' })}
      ${field({ name: 'reserve.memoryMb', label: 'Reserve per server (MB)', control: html`<input class="inf-input" name="reserve.memoryMb" type="number" min="0" max="65536" step="1" value="512"${describedBy('reserve.memoryMb')}>` })}
    </div>
    <div class="actions">${button({ label: 'Create site', type: 'submit' })}${button({ label: 'Cancel', kind: 'secondary', attrs: { 'data-action': 'site-close' } })}</div>
  </form>`;
}

function enrolmentCard(e) {
  return card({
    label: `Add a server to ${e.site}`,
    title: `Add a server to ${e.site}`,
    meta: html`Valid until <time datetime="${e.expiresAt}">${new Date(e.expiresAt).toLocaleTimeString()}</time>, for one server. It is shown only now.`,
    body: html`<p>On the server (Ubuntu 22.04 or 24.04 with Docker Engine and Node 22), run:</p>
      ${copyField(e.command, { label: 'Copy the install command' })}
      <p class="inf-sub">It installs the agent as the noobly-agent service and enrols it. Add <code>--install-docker --install-node</code> to install those too. Without systemd it prints the command to run instead.</p>
      ${e.manual ? html`<p>Or, from a copy of the agent folder, without installing:</p>${copyField(e.manual, { label: 'Copy the manual command' })}` : ''}
      <p class="inf-sub">The agent trades the token for its own credential on first connection; the token cannot be used again.</p>
      <div class="actions">${button({ label: 'Done', kind: 'secondary', small: true, attrs: { 'data-action': 'enrol-close' } })}</div>`,
  });
}

function usage(s) {
  if (!s.allocatable) return html`<span class="inf-muted">No facts yet</span>`;
  const { cpu, memoryMb } = s.allocatable;
  const r = s.reserved;
  const tone = (x) => (x >= 0.9 ? 'danger' : x >= 0.75 ? 'warning' : undefined);
  return html`${meter({ label: 'CPU', value: `${r.cpu} of ${cpu} vCPU`, ratio: cpu ? r.cpu / cpu : 0, tone: tone(cpu ? r.cpu / cpu : 0) })}
    ${meter({ label: 'Memory', value: `${memory(r.memoryMb)} of ${memory(memoryMb)}`, ratio: memoryMb ? r.memoryMb / memoryMb : 0, tone: tone(memoryMb ? r.memoryMb / memoryMb : 0) })}`;
}

function facts(s) {
  const f = s.facts ?? {};
  return kv([
    ['OS', f.os ? `${f.os}${f.kernel ? ` · kernel ${f.kernel}` : ''}` : null],
    ['Machine', f.cpus ? `${f.cpus} CPUs · ${memory(f.memoryMb ?? 0)}${f.diskFreeGb != null ? ` · ${f.diskFreeGb} GB disk free` : ''}` : null],
    ['Docker', f.docker ? `${f.docker}${f.cgroup ? ` · cgroup v${f.cgroup}` : ''}` : null],
    ['Addresses', f.addresses?.length ? f.addresses.join(', ') : null],
    ['Agent', s.agentVersion ? html`${s.agentVersion}${s.outdated ? html` <span class="inf-tone inf-tone--warning">Outdated: run the install again</span>` : ''}` : null],
  ]);
}

function serverTable(site) {
  return dataTable({
    caption: `Servers of ${site.id}`,
    empty: 'No servers yet. Add one with Add server.',
    rows: site.servers,
    columns: [
      { key: 'hostname', label: 'Server', render: (s) => html`<strong>${s.hostname}</strong><span class="inf-sub inf-mono">${s.id}</span>${facts(s)}` },
      {
        key: 'status',
        label: 'Status',
        render: (s) => {
          const [text, tone] = STATUS[s.status] ?? [s.status, 'neutral'];
          return html`${statusPill({ text, tone })}${s.lastSeenAt ? html`<span class="inf-sub">Seen <time datetime="${s.lastSeenAt}">${ago(s.lastSeenAt)}</time></span>` : ''}${s.warnings.map((w) => html`<span class="inf-sub inf-tone inf-tone--warning">Warning: ${w}</span>`)}`;
        },
      },
      { key: 'reserved', label: 'Reserved', render: usage },
      { key: 'instances', label: 'Instances', render: (s) => (s.instances.length ? html`<ul class="inf-links">${s.instances.map((i) => html`<li><span class="inf-mono">${i.tenant}/${i.workload}</span> · ${i.status}${i.url ? html` · <span class="inf-mono">${i.url}</span>` : ''}</li>`)}</ul>` : html`<span class="inf-muted">None</span>`) },
      { key: 'actions', label: 'Actions', render: (s) => button({ label: 'Remove server', kind: 'secondary', small: true, attrs: { 'data-action': 'server-remove', 'data-id': s.id, 'data-name': s.hostname } }) },
    ],
  });
}

const siteCard = (site) => card({
  label: `Site ${site.id}`,
  title: html`${site.name} <span class="inf-sub inf-mono">${site.id}</span>`,
  meta: `${plural(site.servers.length, 'server')} · ${site.online} online · binds ${site.bind} · reserves ${site.reserve.cpu} vCPU and ${memory(site.reserve.memoryMb)} per server`,
  body: html`${serverTable(site)}<div class="actions">${button({ label: 'Add server', small: true, attrs: { 'data-action': 'enrol', 'data-site': site.id } })}</div>`,
});

/**
 * Draws the section into `region` and handles its actions.
 * @param {HTMLElement} view    the page (for the message region and dialogs)
 * @param {HTMLElement} region
 * @param {object} ctx
 */
export async function renderSites(view, region, ctx) {
  region.innerHTML = String(html`<section aria-labelledby="inf-sites-h">
    <div class="page-head"><h2 class="card__title" id="inf-sites-h">Sites and servers</h2>
      <div class="actions">${button({ label: 'Create site', kind: 'secondary', small: true, attrs: { 'data-action': 'site-open' } })}</div></div>
    <div data-region="site-form" hidden></div>
    <div data-region="enrolment" hidden></div>
    <div data-region="sites"></div>
  </section>`);
  const formRegion = region.querySelector('[data-region="site-form"]');
  const enrolRegion = region.querySelector('[data-region="enrolment"]');
  const list = region.querySelector('[data-region="sites"]');
  const tell = (text, tone) => say(view, text, tone);

  const redraw = await reloadable(list, ctx, async () => {
    let data;
    try {
      data = await ctx.api.get('platform/local');
    } catch (err) {
      if (isAbort(err)) return 0;
      list.innerHTML = String(err?.status === 404
        ? notice({ title: 'No local servers here', text: 'The launcher does not pass WebSocket upgrades through host.onUpgrade, so agents cannot connect.', tone: 'muted', iconName: 'info' })
        : errorCard(err, 'sites and servers'));
      region.querySelector('[data-action="site-open"]')?.setAttribute('hidden', '');
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    list.innerHTML = String(data.sites.length
      ? html`${data.sites.map(siteCard)}`
      : notice({ title: 'No sites yet', text: 'A site is a group of your own servers on one network. It becomes a region services can run in.', tone: 'muted', iconName: 'info' }));
    return data.sites.some((s) => s.servers.some((x) => x.status === 'enrolling')) ? 2000 : 0;
  });

  const showErrors = (fields = {}) => {
    for (const el of formRegion.querySelectorAll('[data-error]')) el.textContent = '';
    for (const el of formRegion.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    for (const [name, text] of Object.entries(fields)) {
      const target = formRegion.querySelector(`[data-error="${name}"]`);
      if (target) target.textContent = text;
      formRegion.querySelector(`[name="${name}"]`)?.setAttribute('aria-invalid', 'true');
    }
    formRegion.querySelector('[aria-invalid="true"]')?.focus();
  };
  const closeForm = () => {
    formRegion.hidden = true;
    formRegion.replaceChildren();
  };
  const closeEnrolment = () => {
    enrolRegion.hidden = true;
    enrolRegion.replaceChildren();
  };

  wireCopy(region, ctx.signal, tell);

  region.addEventListener('submit', async (event) => {
    if (event.target.dataset.form !== 'site') return;
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.target));
    const body = { id: f.id, name: f.name, bind: f.bind, reserve: { cpu: Number(f['reserve.cpu']), memoryMb: Number(f['reserve.memoryMb']) } };
    const submit = event.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const site = await ctx.api.post('platform/local/sites', body);
      closeForm();
      tell(`Created site ${site.name}. Add a server to it next.`, 'success');
      await redraw();
    } catch (err) {
      if (isAbort(err)) return;
      if (err.details?.fields) showErrors(err.details.fields);
      else tell(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }, { signal: ctx.signal });

  region.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target) return undefined;
    const { action } = target.dataset;
    if (action === 'site-open') {
      formRegion.innerHTML = String(siteForm());
      formRegion.hidden = false;
      formRegion.querySelector('input[name="id"]').focus();
      return undefined;
    }
    if (action === 'site-close') return closeForm();
    if (action === 'enrol-close') return closeEnrolment();
    try {
      if (action === 'enrol') {
        target.disabled = true;
        const e = await ctx.api.post(`platform/local/sites/${encodeURIComponent(target.dataset.site)}/enrolments`);
        enrolRegion.innerHTML = String(enrolmentCard(e));
        enrolRegion.hidden = false;
        enrolRegion.querySelector('[data-copy]')?.focus();
        tell(`Enrolment command ready for ${e.site}. It works once, for an hour.`, 'success');
      }
      if (action === 'server-remove') {
        const { id, name } = target.dataset;
        const ok = await confirmDialog(view, {
          title: `Remove ${name}?`,
          text: 'Its agent is disconnected at once and its credential stops working. Containers already on it keep running until you stop them there. To use the machine again, enrol it with Add server.',
          confirmLabel: 'Remove server',
          typeToConfirm: name,
        });
        if (!ok) return undefined;
        await ctx.api.del(`platform/local/servers/${encodeURIComponent(id)}`);
        tell(`Removed ${name}.`, 'success');
        await redraw();
      }
    } catch (err) {
      if (!isAbort(err)) tell(err.message, 'error');
    } finally {
      target.disabled = false;
    }
    return undefined;
  }, { signal: ctx.signal });
}
