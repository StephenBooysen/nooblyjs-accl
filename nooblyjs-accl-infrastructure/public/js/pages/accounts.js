// Cloud accounts (no mockup yet; product.md §6.11): the GCP projects and AWS accounts Noobly Cloud works in, whether
// each is connected, and connecting a new one. Only an Owner (change-guardrails) connects or removes. Data:
// GET /accounts, GET /about (which providers this install uses), GET /catalog?cloud= (regions for the form).
// Below them, the Git connections (roadmap 6.1; product.md §6.11): a GitHub or GitLab personal access token, checked
// on save and daily, that clones private repositories and adds webhooks. Data: GET /git/connections.
import { pageHead, notice, statusPill, dataTable, card } from '/ui/js/components/index.js';
import { ago } from '/ui/js/format.js';
import { html, button, errorCard, isAbort, reloadable, say, messageRegion, REFRESH_MS } from '../lib.js';
import { cloudBadge, confirmDialog } from '../components/index.js';
import { resourceNameProblem } from '../shared/names.js';
import { showFieldErrors } from '../forms.js';

const CLOUDS = [
  { id: 'gcp', label: 'Google Cloud', idField: 'projectId', idLabel: 'Project ID', idHelp: 'The GCP project to work in, e.g. stevie-prod.', credentials: 'Service account key (JSON)', credentialsHelp: 'A key for a service account with the Compute Admin, Cloud SQL Admin and Storage Admin roles on the project.' },
  { id: 'aws', label: 'Amazon Web Services', idField: 'accountId', idLabel: 'Account ID', idHelp: 'The 12-digit AWS account ID.', credentials: 'Role ARN and external ID', credentialsHelp: 'The ARN of a role Noobly Cloud may assume, and its external ID, one per line. Access keys work too.' },
];

const field = (name, label, control, help) => html`<div class="inf-field"><label class="inf-field__label" for="inf-acc-${name}">${label}</label>${control}${help ? html`<span class="inf-help" id="inf-acc-${name}-help">${help}</span>` : ''}<span class="inf-error" data-error="${name}" id="inf-acc-${name}-error" aria-live="polite"></span></div>`;

function form(catalogs) {
  return html`<form class="card inf-form" data-form="connect" novalidate aria-labelledby="inf-connect-h">
    <h2 class="card__title" id="inf-connect-h">Connect a cloud account</h2>
    <fieldset class="inf-choice"><legend class="inf-field__label">Cloud</legend>
      ${CLOUDS.map((c, i) => html`<label class="inf-option"><input type="radio" name="cloud" value="${c.id}"${i === 0 ? html` checked` : ''}>${cloudBadge(c.id)}<span>${c.label}</span></label>`)}
    </fieldset>
    <span class="inf-error" data-error="cloud" aria-live="polite"></span>
    <div class="inf-form__row">
      ${field('name', 'Name', html`<input class="inf-input inf-mono" id="inf-acc-name" name="name" required autocomplete="off" spellcheck="false" aria-describedby="inf-acc-name-help inf-acc-name-error">`, 'What Noobly Cloud calls it. Lower-case letters, numbers and dashes.')}
      ${CLOUDS.map((c, i) => html`<div data-cloud="${c.id}"${i ? html` hidden` : ''}>${field(c.idField, c.idLabel, html`<input class="inf-input inf-mono" id="inf-acc-${c.idField}" name="${c.idField}" autocomplete="off" spellcheck="false" aria-describedby="inf-acc-${c.idField}-help inf-acc-${c.idField}-error"${c.id === 'aws' ? html` inputmode="numeric"` : ''}${i ? html` disabled` : ''}>`, c.idHelp)}</div>`)}
    </div>
    ${CLOUDS.map((c, i) => html`<div data-cloud="${c.id}"${i ? html` hidden` : ''}>
      ${field(`defaultRegion-${c.id}`, 'Default region', html`<select class="inf-input" id="inf-acc-defaultRegion-${c.id}" name="defaultRegion" aria-describedby="inf-acc-defaultRegion-${c.id}-error"${i ? html` disabled` : ''}>${(catalogs[c.id]?.regions ?? []).map((r) => html`<option value="${r.id}">${r.id} · ${r.label}</option>`)}</select>`)}
      ${field(`credentials-${c.id}`, c.credentials, html`<textarea class="inf-input inf-mono" id="inf-acc-credentials-${c.id}" name="credentials" rows="5" spellcheck="false" autocomplete="off" aria-describedby="inf-acc-credentials-${c.id}-help inf-acc-credentials-${c.id}-error"${i ? html` disabled` : ''}></textarea>`, c.credentialsHelp)}
    </div>`)}
    <span class="inf-error" data-error="provider" aria-live="polite"></span>
    <div class="actions">${button({ label: 'Connect', type: 'submit' })}${button({ label: 'Cancel', kind: 'secondary', attrs: { 'data-action': 'connect-close' } })}</div>
  </form>`;
}

function accountsTable(accounts, ctx) {
  const canChange = ctx.can('change-guardrails');
  const canCheck = ctx.can('draft');
  return dataTable({
    caption: 'Cloud accounts',
    empty: 'No cloud accounts yet.',
    rows: accounts,
    columns: [
      { key: 'name', label: 'Account', render: (a) => html`<span class="inf-inline">${cloudBadge(a.cloud)}<span><strong>${a.label}</strong><span class="inf-sub">${a.cloud === 'gcp' ? `Project ${a.projectId}` : `Account ${a.accountId}`} · ${a.providerLabel}</span></span></span>` },
      { key: 'region', label: 'Default region', render: (a) => a.regionLabel },
      { key: 'state', label: 'Status', render: (a) => html`${statusPill({ text: a.stateText, tone: a.stateTone })}${a.stateMessage ? html`<span class="inf-sub">${a.stateMessage}</span>` : ''}` },
      { key: 'checked', label: 'Last checked', render: (a) => (a.checkedAt ? html`<time datetime="${a.checkedAt}">${ago(a.checkedAt)}</time>` : '—') },
      { key: 'resources', label: 'Resources', numeric: true, render: (a) => String(a.resources?.total ?? 0) },
      {
        key: 'actions',
        label: html`<span class="visually-hidden">Actions</span>`,
        render: (a) => html`<span class="inf-actions">${canCheck ? button({ label: 'Check now', kind: 'secondary', small: true, attrs: { 'data-action': 'check', 'data-id': a.id } }) : ''}${canChange ? button({ label: 'Remove', kind: 'secondary', small: true, attrs: { 'data-action': 'remove', 'data-id': a.id } }) : ''}</span>`,
      },
    ],
  });
}

const GIT = [['github', 'GitHub'], ['gitlab', 'GitLab']];

function gitForm(help) {
  return html`<form class="card inf-form" data-form="git" novalidate aria-labelledby="inf-git-h">
    <h2 class="card__title" id="inf-git-h">Add a Git connection</h2>
    <fieldset class="inf-choice"><legend class="inf-field__label">Git host</legend>
      ${GIT.map(([id, label], i) => html`<label class="inf-option"><input type="radio" name="provider" value="${id}"${i === 0 ? html` checked` : ''}><span>${label}</span></label>`)}
    </fieldset>
    <span class="inf-error" data-error="provider" aria-live="polite"></span>
    ${field('token', 'Personal access token', html`<input class="inf-input inf-mono" id="inf-acc-token" name="token" type="password" required autocomplete="off" spellcheck="false" aria-describedby="inf-acc-token-help inf-acc-token-error">`, html`<span data-git-help>${help.github}</span> We check whose it is, its scopes and its expiry now and every day, and keep it encrypted. It is never shown again.`)}
    <div class="actions">${button({ label: 'Add connection', type: 'submit' })}${button({ label: 'Cancel', kind: 'secondary', attrs: { 'data-action': 'git-close' } })}</div>
  </form>`;
}

const GIT_STATE = { connected: ['Connected', 'success'], 'needs-attention': ['Needs attention', 'warning'], failed: ['Not working', 'danger'] };

function gitTable(connections, ctx) {
  const canChange = ctx.can('change-guardrails');
  return dataTable({
    caption: 'Git connections',
    empty: 'No Git connections. Public repositories deploy without one; add one for private repositories and auto-deploy.',
    rows: connections,
    columns: [
      { key: 'id', label: 'Connection', render: (c) => html`<strong>${c.providerLabel}</strong> as <strong>${c.user}</strong><span class="inf-sub inf-mono">${c.id}</span>` },
      { key: 'repos', label: 'Repositories', numeric: true, render: (c) => (c.repoCount === null ? '—' : String(c.repoCount)) },
      { key: 'expires', label: 'Token expires', render: (c) => (c.expiresAt ? html`<time datetime="${c.expiresAt}">${new Date(c.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</time>` : 'Never') },
      { key: 'state', label: 'Status', render: (c) => html`${statusPill({ text: (GIT_STATE[c.state] ?? [c.state])[0], tone: (GIT_STATE[c.state] ?? [null, 'neutral'])[1] })}${c.problem ? html`<span class="inf-sub">${c.problem}</span>` : ''}` },
      { key: 'apps', label: 'Used by', render: (c) => (c.apps.length ? c.apps.join(', ') : html`<span class="inf-muted">No apps</span>`) },
      {
        key: 'actions',
        label: html`<span class="visually-hidden">Actions</span>`,
        render: (c) => (canChange ? html`<span class="inf-actions">${button({ label: 'Check now', kind: 'secondary', small: true, attrs: { 'data-action': 'git-test', 'data-id': c.id } })}${button({ label: 'Remove', kind: 'secondary', small: true, attrs: { 'data-action': 'git-remove', 'data-id': c.id } })}</span>` : ''),
      },
    ],
  });
}

export async function render(view, { ctx }) {
  const canChange = ctx.can('change-guardrails');
  let about = { providers: [] };
  const catalogs = {};
  try {
    about = await ctx.api.get('about');
  } catch (err) {
    if (isAbort(err)) return;
  }
  const mockOnly = about.providers?.length && about.providers.every((p) => p === 'mock');

  view.innerHTML = String(html`${pageHead({
    title: 'Cloud accounts',
    lead: 'The GCP projects and AWS accounts Noobly Cloud works in.',
    actions: canChange ? button({ label: 'Connect account', icon: 'plus', attrs: { 'data-action': 'connect-open' } }) : '',
  })}
    ${messageRegion()}
    ${mockOnly ? notice({ title: 'Running on the mock cloud', text: 'This install uses the mock cloud: connecting an account creates nothing in Google Cloud or AWS. The GCP and AWS providers arrive in roadmap phase 2.', tone: 'muted', iconName: 'info' }) : ''}
    <div data-region="form" hidden></div>
    <div data-region="list"></div>
    <div class="page-head inf-subhead"><div><h2 class="inf-subhead__title">Git connections</h2><p class="lead">Clone private repositories and redeploy apps when you push.</p></div>${canChange ? button({ label: 'Add Git connection', icon: 'plus', kind: 'secondary', attrs: { 'data-action': 'git-open' } }) : ''}</div>
    <div data-region="git-form" hidden></div>
    <div data-region="git"></div>`);
  const list = view.querySelector('[data-region="list"]');
  const formRegion = view.querySelector('[data-region="form"]');
  const gitRegion = view.querySelector('[data-region="git"]');
  const gitFormRegion = view.querySelector('[data-region="git-form"]');
  let gitHelp = {};

  const redraw = await reloadable(list, ctx, async () => {
    let accounts;
    try {
      ({ accounts } = await ctx.api.get('accounts'));
    } catch (err) {
      if (!isAbort(err)) list.innerHTML = String(errorCard(err, 'the cloud accounts'));
      return 0;
    }
    if (!ctx.isCurrent()) return 0;
    list.innerHTML = String(card({ label: 'Cloud accounts', body: accountsTable(accounts, ctx) }));
    try {
      const git = await ctx.api.get('git/connections');
      gitHelp = git.help;
      gitRegion.innerHTML = String(card({ label: 'Git connections', body: gitTable(git.connections, ctx) }));
    } catch (err) {
      if (!isAbort(err)) gitRegion.innerHTML = String(errorCard(err, 'the Git connections'));
    }
    return accounts.some((a) => a.state === 'connecting') ? REFRESH_MS : 0;
  });

  const showErrors = (fields = {}) => {
    for (const el of formRegion.querySelectorAll('[data-error]')) el.textContent = '';
    for (const el of formRegion.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    for (const [name, text] of Object.entries(fields)) {
      const cloud = formRegion.querySelector('input[name="cloud"]:checked')?.value;
      const target = formRegion.querySelector(`[data-error="${name}"]`) ?? formRegion.querySelector(`[data-error="${name}-${cloud}"]`);
      if (target) target.textContent = text;
      formRegion.querySelector(`[name="${name}"]:not([disabled])`)?.setAttribute('aria-invalid', 'true');
    }
    formRegion.querySelector('[aria-invalid="true"]')?.focus();
  };

  async function openForm() {
    try {
      for (const c of CLOUDS) catalogs[c.id] ??= await ctx.api.get('catalog', { query: { cloud: c.id } });
    } catch (err) {
      if (!isAbort(err)) say(view, `Couldn't load the regions: ${err.message}`, 'error');
      return;
    }
    formRegion.innerHTML = String(form(catalogs));
    formRegion.hidden = false;
    formRegion.querySelector('input[name="name"]').focus();
  }

  view.addEventListener('change', (event) => {
    if (event.target.name === 'provider') {
      const help = gitFormRegion.querySelector('[data-git-help]');
      if (help) help.textContent = gitHelp[event.target.value] ?? '';
      return;
    }
    if (event.target.name !== 'cloud') return;
    for (const block of formRegion.querySelectorAll('[data-cloud]')) {
      const on = block.dataset.cloud === event.target.value;
      block.hidden = !on;
      for (const control of block.querySelectorAll('input, select, textarea')) control.disabled = !on;
    }
  }, { signal: ctx.signal });

  view.addEventListener('submit', async (event) => {
    if (event.target.dataset.form === 'git') {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.target));
      const submit = event.target.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const c = await ctx.api.post('git/connections', body);
        gitFormRegion.hidden = true;
        gitFormRegion.replaceChildren();
        say(view, `Connected ${c.providerLabel} as ${c.user}${c.problem ? `. ${c.problem}` : ` · ${c.repoCount} repositories`}.`, c.state === 'connected' ? 'success' : 'error');
        await redraw();
      } catch (err) {
        if (isAbort(err)) return;
        if (err.details?.fields) showFieldErrors(gitFormRegion, err.details.fields);
        else showFieldErrors(gitFormRegion, { token: err.message });
      } finally {
        submit.disabled = false;
      }
      return;
    }
    if (event.target.dataset.form !== 'connect') return;
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    const problem = resourceNameProblem(body.name);
    if (problem) return showErrors({ name: problem });
    const submit = event.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const { account } = await ctx.api.post('accounts', body);
      formRegion.hidden = true;
      formRegion.replaceChildren();
      say(view, `Connecting ${account.label}. This takes a minute.`, 'success');
      await redraw();
    } catch (err) {
      if (isAbort(err)) return;
      if (err.details?.fields) showErrors(err.details.fields);
      else say(view, err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }, { signal: ctx.signal });

  view.addEventListener('click', async (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === 'connect-open') return openForm();
    if (action === 'git-open') {
      gitFormRegion.innerHTML = String(gitForm(gitHelp));
      gitFormRegion.hidden = false;
      gitFormRegion.querySelector('input[name="token"]').focus();
      return undefined;
    }
    if (action === 'git-close') {
      gitFormRegion.hidden = true;
      gitFormRegion.replaceChildren();
      return undefined;
    }
    if (action === 'connect-close') {
      formRegion.hidden = true;
      formRegion.replaceChildren();
      return undefined;
    }
    try {
      if (action === 'check') {
        target.disabled = true;
        const account = await ctx.api.post(`accounts/${encodeURIComponent(id)}/verify`);
        say(view, `${account.label}: ${account.stateText}${account.stateMessage ? ` — ${account.stateMessage}` : ''}.`, account.state === 'connected' ? 'success' : 'error');
      }
      if (action === 'git-test') {
        target.disabled = true;
        const c = await ctx.api.post(`git/connections/${encodeURIComponent(id)}/test`);
        say(view, `${c.id}: ${(GIT_STATE[c.state] ?? [c.state])[0]}${c.problem ? ` — ${c.problem}` : ''}.`, c.state === 'connected' ? 'success' : 'error');
      }
      if (action === 'git-remove') {
        const ok = await confirmDialog(view, {
          title: `Remove ${id}?`,
          text: 'Its token is deleted. Apps that use it keep running, but can’t redeploy from a private repository or on push until they get another connection.',
          confirmLabel: 'Remove connection',
        });
        if (!ok) return undefined;
        await ctx.api.del(`git/connections/${encodeURIComponent(id)}`);
        say(view, `Removed ${id}.`, 'success');
      }
      if (action === 'remove') {
        const ok = await confirmDialog(view, {
          title: `Remove ${id}?`,
          text: 'Noobly Cloud forgets this account and its credentials. Nothing in the cloud is deleted. An account that still has resources here can’t be removed.',
          confirmLabel: 'Remove account',
          typeToConfirm: id,
        });
        if (!ok) return undefined;
        await ctx.api.del(`accounts/${encodeURIComponent(id)}`, { body: { confirm: id } });
        say(view, `Removed ${id}.`, 'success');
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
