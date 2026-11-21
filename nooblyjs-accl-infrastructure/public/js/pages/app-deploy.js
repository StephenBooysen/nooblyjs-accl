// Deploy an app from Git (infra-deploy-a-app/DeployApp.dc.html; product.md §6.6; roadmap 6.5): the source, checked
// through the Git host when its fields change (Dockerfile found, its port and base image); the VM it runs on, with its load;
// run settings with environment variables (plain, secret, or linked to a database or a bucket); a public HTTPS
// endpoint with its path and health check; and "What happens next", which follows the form. Data: GET /apps/-form,
// POST /git/check, GET /vms/:name/health. Sends POST /apps, then opens the app, which shows its deploy.
import { pageHead, notice } from '/ui/js/components/index.js';
import { html, button, hrefFor, crumbs, errorCard, isAbort, say, messageRegion } from '../lib.js';
import { cloudBadge, formSection, field, describedBy, optionCards, switchRow } from '../components/index.js';
import { formValues, showFieldErrors } from '../forms.js';
import { resourceNameProblem } from '../shared/names.js';

const RESTART = [['always', 'Always'], ['on-failure', 'On failure'], ['never', 'Never']];

const options = (items, value) => items.map(([v, label]) => html`<option value="${v}"${v === value ? html` selected` : ''}>${label}</option>`);
const repoName = (url) => (/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim())?.[1] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40);
const providerOf = (url) => (/^(?:https:\/\/|git@)github\.com[/:]/.test(url) ? 'github' : /^(?:https:\/\/|git@)gitlab\.com[/:]/.test(url) ? 'gitlab' : null);

/** One environment row. kind: plain | database | bucket. The names carry the row's index, so the server's words land. */
function envRow(i, { kind = 'plain', key = '', value = '', secret = false, target = '' }, opts) {
  const keyControl = html`<label class="visually-hidden" for="inf-f-env.${i}.key">Name of variable ${i + 1}</label><input class="inf-input inf-mono" id="inf-f-env.${i}.key" name="env.${i}.key" value="${key}" placeholder="NAME" autocomplete="off" spellcheck="false" aria-describedby="inf-f-env.${i}.key-error">`;
  let valueControl;
  if (kind === 'database' || kind === 'bucket') {
    const list = kind === 'database' ? opts.databases.map((d) => [d.name, `${d.name} · ${d.engine === 'mongodb' ? 'MongoDB' : 'MySQL'} · ${d.account}`]) : opts.buckets.map((b) => [b.name, `${b.name} · ${b.account}`]);
    valueControl = html`<label class="visually-hidden" for="inf-f-env.${i}.value">${kind === 'database' ? 'Database' : 'Bucket'} for variable ${i + 1}</label><select class="inf-input" id="inf-f-env.${i}.value" name="env.${i}.${kind}" aria-describedby="inf-f-env.${i}.value-error">${options(list, target)}</select><span class="inf-sub">${kind === 'database' ? 'Linked: its connection string, set at each deploy' : 'Linked: its name, and access keys when the app has them'}</span>`;
  } else {
    valueControl = html`<label class="visually-hidden" for="inf-f-env.${i}.value">Value of variable ${i + 1}</label><input class="inf-input inf-mono" id="inf-f-env.${i}.value" name="env.${i}.value" value="${value}" type="${secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" aria-describedby="inf-f-env.${i}.value-error"><label class="inf-option inf-env__secret"><input type="checkbox" name="env.${i}.secret"${secret ? html` checked` : ''}><span>Secret</span></label>`;
  }
  return html`<li class="inf-env__row" data-env-row data-kind="${kind}">
    <div class="inf-env__key">${keyControl}<span class="inf-error" data-error="env.${i}.key" id="inf-f-env.${i}.key-error" aria-live="polite"></span></div>
    <div class="inf-env__value">${valueControl}<span class="inf-error" data-error="env.${i}.value" id="inf-f-env.${i}.value-error" aria-live="polite"></span></div>
    ${button({ label: 'Remove', kind: 'secondary', small: true, attrs: { 'data-action': 'env-remove', 'aria-label': `Remove variable ${i + 1}` } })}
  </li>`;
}

export async function render(view, { ctx, query }) {
  view.innerHTML = String(html`${crumbs(ctx, [['Apps', '/apps'], ['Deploy']])}${pageHead({ title: 'Deploy an app from Git', lead: 'We clone the repo, build its Dockerfile on your VM and put it behind HTTPS.' })}<div data-region="body"><p class="inf-muted">Loading…</p></div>`);
  const body = view.querySelector('[data-region="body"]');
  if (!ctx.can('draft')) {
    body.innerHTML = String(notice({ title: 'Deploying an app needs the draft permission', text: 'Ask an Owner to give you the Contributor role.', tone: 'muted' }));
    return;
  }
  let opts;
  try {
    opts = await ctx.api.get('apps/-form');
  } catch (err) {
    if (!isAbort(err)) body.innerHTML = String(errorCard(err, 'what you can deploy to'));
    return;
  }
  const running = opts.vms.filter((v) => v.status === 'running' && v.docker);
  if (!opts.vms.length) {
    body.innerHTML = String(notice({ title: 'Launch a VM first', text: 'An app runs as a container on one of your VMs.', actions: button({ label: 'Launch VM', href: hrefFor(ctx, '/vms/new') }) }));
    return;
  }
  const firstVm = running.find((v) => v.name === query.get('vm'))?.name ?? running[0]?.name ?? null;
  const conn = opts.connections[0] ?? null;
  let checking = 0;

  const vmCards = () => optionCards({
    name: 'vm',
    legend: 'Virtual machine',
    value: firstVm,
    wide: true,
    items: opts.vms.map((v) => ({
      value: v.name,
      badge: v.cloud ? cloudBadge(v.cloud) : '',
      title: v.name,
      text: html`<span data-load="${v.name}">${v.status !== 'running' ? `${v.status[0].toUpperCase()}${v.status.slice(1)}` : !v.docker ? 'No Docker' : `${v.apps} app${v.apps === 1 ? '' : 's'}`}</span>`,
      disabled: v.status !== 'running' || !v.docker,
    })),
  });

  body.innerHTML = String(html`${messageRegion()}<div class="inf-split"><form class="inf-split__main" id="inf-deploy-form" data-form="deploy" novalidate>
    ${formSection({ n: 1, id: 'source', title: 'Source', body: html`
      <p class="inf-note">${conn ? html`${conn.providerLabel} connected as <strong>${conn.user}</strong>${conn.repoCount !== null ? ` · ${conn.repoCount} repositories` : ''}${conn.problem ? html` · <span class="inf-tone inf-tone--warning">${conn.problem}</span>` : ''}` : 'No Git connection: public repositories only.'} <a href="${hrefFor(ctx, '/accounts')}">${conn ? 'Use another Git host' : 'Add a Git connection'}</a></p>
      ${field({ name: 'repo', label: 'Repository URL', control: html`<input class="inf-input inf-mono" name="repo" placeholder="https://github.com/you/app.git" autocomplete="off" spellcheck="false" required${describedBy('repo')}>`, help: 'Public or private. Private repositories are cloned with the Git connection’s token.' })}
      <div class="inf-form__row">
        ${field({ name: 'branch', label: 'Branch', control: html`<input class="inf-input inf-mono" name="branch" value="main" list="inf-branches" autocomplete="off" spellcheck="false"${describedBy('branch')}><datalist id="inf-branches"></datalist>` })}
        ${field({ name: 'gitConnection', label: 'Git connection', control: html`<select class="inf-input" name="gitConnection"${describedBy('gitConnection')}>${options([...opts.connections.map((c) => [c.id, `${c.providerLabel} as ${c.user}`]), ['', 'None (a public repository)']], conn?.id ?? '')}</select>` })}
      </div>
      <div class="inf-form__row">
        ${field({ name: 'dockerfile', label: 'Dockerfile path', control: html`<input class="inf-input inf-mono" name="dockerfile" value="./Dockerfile" autocomplete="off" spellcheck="false"${describedBy('dockerfile')}>` })}
        ${field({ name: 'context', label: 'Build context', control: html`<input class="inf-input inf-mono" name="context" value="." autocomplete="off" spellcheck="false"${describedBy('context')}>` })}
      </div>
      <p class="inf-note" data-check role="status" aria-live="polite"></p>
      ${switchRow({ name: 'autoDeploy', title: html`Redeploy when <span data-branch-name>main</span> is pushed`, text: 'We add a webhook to the repo. Each push builds a new image and swaps it in once it passes the health check.' })}` })}
    ${formSection({ n: 2, id: 'where', title: 'Where it runs', body: html`${vmCards()}<p><a href="${hrefFor(ctx, '/vms/new')}">Launch a new VM for this app</a></p>` })}
    ${formSection({ n: 3, id: 'run', title: 'Run settings', body: html`
      <div class="inf-form__row">
        ${field({ name: 'name', label: 'App name', control: html`<input class="inf-input inf-mono" name="name" autocomplete="off" spellcheck="false" required${describedBy('name')}>`, help: 'Lower-case letters, numbers and dashes.' })}
        ${field({ name: 'port', label: 'Container port', control: html`<input class="inf-input" type="number" name="port" min="1" max="65535" step="1" inputmode="numeric"${describedBy('port')}>`, help: 'Where the app listens inside its container.' })}
        ${field({ name: 'restart', label: 'Restart policy', control: html`<select class="inf-input" name="restart"${describedBy('restart')}>${options(RESTART, 'always')}</select>` })}
      </div>
      <fieldset class="inf-env"><legend class="inf-field__label">Environment variables</legend>
        <ul class="inf-env__rows" data-region="env"></ul>
        <span class="inf-error" data-error="env" aria-live="polite"></span>
        <div class="actions">${button({ label: 'Add variable', icon: 'plus', kind: 'secondary', small: true, attrs: { 'data-action': 'env-add' } })}${opts.databases.length ? button({ label: 'Link a database', kind: 'secondary', small: true, attrs: { 'data-action': 'env-database' } }) : ''}${opts.buckets.length ? button({ label: 'Link a bucket', kind: 'secondary', small: true, attrs: { 'data-action': 'env-bucket' } }) : ''}</div>
      </fieldset>` })}
    ${formSection({ n: 4, id: 'endpoint', title: 'Public HTTPS endpoint', body: html`
      ${switchRow({ name: 'endpoint.enabled', title: 'Serve this app on HTTPS', text: 'Turn off for background workers that only talk to other services.', checked: true })}
      <div data-endpoint>
        ${optionCards({ name: 'endpoint.address', legend: 'Address', value: 'domain', items: [
          { value: 'domain', title: 'Use my own domain', text: 'A free certificate from Let’s Encrypt that renews itself, once you add one DNS record.' },
          { value: 'cloud', title: 'Use the VM’s address', text: 'Its IP or DNS name, with a self-signed certificate browsers warn about.' },
        ] })}
        <div class="inf-form__row">
          ${field({ name: 'endpoint.domain', label: 'Domain', control: html`<input class="inf-input inf-mono" name="endpoint.domain" placeholder="shop.example.com" autocomplete="off" spellcheck="false"${describedBy('endpoint.domain')}>`, help: 'The app’s page shows the DNS record to add.' })}
          ${field({ name: 'endpoint.path', label: 'Path', control: html`<input class="inf-input inf-mono" name="endpoint.path" value="/" autocomplete="off" spellcheck="false"${describedBy('endpoint.path')}>`, help: 'Several apps can share an address: /, /blog, /api.', wrap: 'inf-field--narrow' })}
        </div>
      </div>
      ${field({ name: 'healthCheck', label: 'Health check', control: html`<input class="inf-input inf-mono" name="healthCheck" value="/healthz" autocomplete="off" spellcheck="false"${describedBy('healthCheck')}>`, help: 'Traffic switches only after this returns 200. Leave empty for a worker: it must keep running for 10 seconds.', wrap: 'inf-field--narrow' })}` })}
  </form>
  <div class="inf-split__side"><aside class="card inf-summary" aria-labelledby="inf-next-h">
    <h2 class="card__title" id="inf-next-h">What happens next</h2>
    <ol class="inf-next" data-region="next"></ol>
    <button class="btn btn--primary inf-summary__action" type="submit" form="inf-deploy-form" data-submit>Deploy</button>
    <p class="inf-summary__foot" data-foot></p>
  </aside></div></div>`);

  const form = body.querySelector('form[data-form="deploy"]');
  const envList = body.querySelector('[data-region="env"]');
  const checkLine = body.querySelector('[data-check]');

  /** Reads the rows as they stand, so a redraw (to renumber) keeps what was typed. */
  function readEnv() {
    return [...envList.querySelectorAll('[data-env-row]')].map((row) => {
      const kind = row.dataset.kind;
      const get = (suffix) => row.querySelector(`[name$=".${suffix}"]`);
      if (kind !== 'plain') return { kind, key: get('key').value, target: get(kind).value };
      return { kind, key: get('key').value, value: get('value').value, secret: Boolean(get('secret').checked) };
    });
  }
  function drawEnv(rows) {
    envList.innerHTML = String(html`${rows.map((r, i) => envRow(i, r, opts))}`);
  }

  function update() {
    const v = formValues(form);
    const toggle = (selector, on) => {
      for (const block of body.querySelectorAll(selector)) {
        block.hidden = !on;
        for (const c of block.querySelectorAll('input, select, textarea')) c.disabled = !on;
      }
    };
    const https = Boolean(v['endpoint.enabled']);
    toggle('[data-endpoint]', https);
    toggle('[data-field="endpoint.domain"]', https && formValues(form)['endpoint.address'] === 'domain');
    const values = formValues(form);
    const vm = values.vm ?? '—';
    const name = values.name || repoName(values.repo) || 'the app';
    const repo = values.repo ? values.repo.replace(/^https:\/\/[^/]+\//, '').replace(/\.git$/, '') : 'the repository';
    for (const el of body.querySelectorAll('[data-branch-name]')) el.textContent = values.branch || 'main';
    const vars = readEnv().filter((r) => r.key).length;
    const url = !https ? null : values['endpoint.address'] === 'domain' ? `https://${values['endpoint.domain'] || 'your-domain'}${values['endpoint.path'] && values['endpoint.path'] !== '/' ? values['endpoint.path'] : ''}` : `https://${vm}’s address`;
    const steps = [
      ['Clone', `${repo} @ ${values.branch || 'main'}`],
      [`Build the image on ${vm}`, `From ${values.dockerfile || './Dockerfile'}, usually 1–2 minutes`],
      ['Start the container', `${values.port ? `Port ${values.port}` : 'No port'} · ${vars} variable${vars === 1 ? '' : 's'} · restarts ${RESTART.find(([k]) => k === values.restart)?.[1].toLowerCase() ?? 'always'}`],
      ['Check health', values.healthCheck ? `GET ${values.healthCheck} must return 200` : 'The container must keep running'],
      ...(url ? [['Go live on HTTPS', url]] : [['Stay private', 'No public endpoint']]),
    ];
    body.querySelector('[data-region="next"]').innerHTML = String(html`${steps.map(([title, text], i) => html`<li class="inf-next__step"><span class="inf-step" aria-hidden="true">${i + 1}</span><span><span class="inf-next__title">${title}</span><span class="inf-sub">${text}</span></span></li>`)}`);
    body.querySelector('[data-submit]').textContent = `Deploy ${name}`;
    body.querySelector('[data-foot]').textContent = `No extra cost · runs on ${vm}`;
  }

  /** Asks the Git host about the repository: the Dockerfile's port and base image, the branches. */
  async function check() {
    const v = formValues(form);
    if (!v.repo) {
      checkLine.textContent = '';
      return;
    }
    const mine = ++checking;
    checkLine.textContent = 'Checking the repository…';
    try {
      const out = await ctx.api.post('git/check', { repo: v.repo, branch: v.branch || null, dockerfile: v.dockerfile, gitConnection: v.gitConnection || null });
      if (mine !== checking || !ctx.isCurrent()) return;
      if (out.branches) body.querySelector('#inf-branches').innerHTML = String(html`${out.branches.map((b) => html`<option value="${b}"></option>`)}`);
      if (out.found === true) {
        checkLine.className = 'inf-note inf-tone inf-tone--success';
        checkLine.textContent = `Found ${v.dockerfile || './Dockerfile'}${out.stages > 1 ? ` (${out.stages} stages)` : ''} · ${out.port ? `exposes port ${out.port}` : 'no EXPOSE: set the container port'} · ${out.baseImage}${out.commit?.sha ? ` · ${out.commit.sha.slice(0, 7)} on ${out.branch}` : ''}`;
        const port = form.querySelector('[name="port"]');
        if (!port.value && out.port) port.value = out.port;
      } else {
        checkLine.className = `inf-note inf-tone inf-tone--${out.found === null ? 'info' : 'warning'}`;
        checkLine.textContent = out.message;
      }
      const nameBox = form.querySelector('[name="name"]');
      if (!nameBox.value || nameBox.dataset.auto === 'true') {
        nameBox.value = repoName(v.repo);
        nameBox.dataset.auto = 'true';
      }
      update();
    } catch (err) {
      if (isAbort(err) || mine !== checking) return;
      checkLine.className = 'inf-note inf-tone inf-tone--warning';
      checkLine.textContent = err.details?.fields ? Object.values(err.details.fields)[0] : err.message;
    }
  }

  /** Each running VM's load, for its card: apps, CPU and free memory (the server keeps health a minute). */
  async function loads() {
    await Promise.all(running.map(async (v) => {
      try {
        const h = await ctx.api.get(`vms/${encodeURIComponent(v.name)}/health`);
        const el = body.querySelector(`[data-load="${v.name}"]`);
        if (!el || h.problem) return;
        const free = h.memory ? `${Math.max(0, h.memory.totalGb - h.memory.usedGb).toFixed(1)} GB free` : null;
        el.textContent = [`${v.apps} app${v.apps === 1 ? '' : 's'}`, h.cpuPercent === null ? null : `CPU ${h.cpuPercent}%`, free].filter(Boolean).join(' · ');
      } catch { /* the card keeps its app count */ }
    }));
  }

  drawEnv([]);
  update();
  loads();

  body.addEventListener('input', (event) => {
    const { name } = event.target;
    if (name === 'name') {
      event.target.dataset.auto = 'false';
      const problem = event.target.value ? resourceNameProblem(event.target.value) : null;
      body.querySelector('[data-error="name"]').textContent = problem ?? '';
    }
    update();
  }, { signal: ctx.signal });
  body.addEventListener('change', (event) => {
    const { name } = event.target;
    if (name === 'repo') {
      // Pick the connection for the repository's host.
      const provider = providerOf(event.target.value);
      const select = form.querySelector('[name="gitConnection"]');
      const fit = opts.connections.find((c) => c.provider === provider);
      if (select.value && opts.connections.find((c) => c.id === select.value)?.provider !== provider) select.value = fit?.id ?? '';
    }
    // The repository is checked when a field that names it is left (a change event), not on each key.
    if (['repo', 'branch', 'dockerfile', 'gitConnection'].includes(name)) check();
    if (/^env\.\d+\.secret$/.test(name)) event.target.closest('[data-env-row]').querySelector('[name$=".value"]').type = event.target.checked ? 'password' : 'text';
    update();
  }, { signal: ctx.signal });

  body.addEventListener('click', (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (!action.startsWith('env-')) return;
    event.preventDefault();
    const rows = readEnv();
    if (action === 'env-add') rows.push({ kind: 'plain' });
    if (action === 'env-database') rows.push({ kind: 'database', key: rows.some((r) => r.key === 'DATABASE_URL') ? '' : 'DATABASE_URL', target: opts.databases[0]?.name });
    if (action === 'env-bucket') rows.push({ kind: 'bucket', key: rows.some((r) => r.key === 'BUCKET') ? '' : 'BUCKET', target: opts.buckets[0]?.name });
    if (action === 'env-remove') rows.splice([...envList.querySelectorAll('[data-env-row]')].indexOf(target.closest('[data-env-row]')), 1);
    drawEnv(rows);
    update();
    if (action !== 'env-remove') envList.querySelector('[data-env-row]:last-child input')?.focus();
  }, { signal: ctx.signal });

  body.addEventListener('submit', async (event) => {
    event.preventDefault();
    const v = formValues(form);
    const payload = {
      name: v.name, repo: v.repo, branch: v.branch || 'main', gitConnection: v.gitConnection || null, dockerfile: v.dockerfile, context: v.context,
      vm: v.vm ?? null, port: v.port === '' ? null : Number(v.port), restart: v.restart, healthCheck: v.healthCheck || null, autoDeploy: Boolean(v.autoDeploy),
      env: readEnv().map((r) => (r.kind === 'database' ? { key: r.key, link: { database: r.target } } : r.kind === 'bucket' ? { key: r.key, link: { bucket: r.target } } : { key: r.key, value: r.value, ...(r.secret ? { secret: true } : {}) })),
      endpoint: v['endpoint.enabled'] ? { address: v['endpoint.address'], domain: v['endpoint.domain'] ?? null, path: v['endpoint.path'] || '/' } : null,
    };
    const problem = resourceNameProblem(payload.name);
    if (problem) return showFieldErrors(body, { name: problem });
    const submit = body.querySelector('[data-submit]');
    submit.disabled = true;
    try {
      const { app } = await ctx.api.post('apps', payload);
      if (ctx.navigate) ctx.navigate(`/apps/${app.name}`);
      else say(body, `Deploying ${app.name}.`, 'success');
    } catch (err) {
      if (isAbort(err)) return undefined;
      if (err.details?.fields) showFieldErrors(body, err.details.fields);
      else say(body, err.message, 'error');
    } finally {
      submit.disabled = false;
    }
    return undefined;
  }, { signal: ctx.signal });
}
