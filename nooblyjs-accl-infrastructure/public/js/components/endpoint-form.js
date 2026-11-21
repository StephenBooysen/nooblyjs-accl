// Adding or changing a public HTTPS endpoint (product.md §6.3 section 5, §6.4 "HTTPS endpoints"; roadmap phase 3):
// the cloud's address or the person's domain, the path, the traffic port, the certificate (Let's Encrypt or their own)
// and whether HTTP redirects to HTTPS. And the line that tells a person which DNS record to add. Every control is a
// real form control with a label; the server checks everything again and its words land under the fields.
import { html } from '/ui/js/html.js';
import { field, describedBy, optionCards, switchRow } from './form.js';

/** "Add at your DNS host: A shop.example.com → 203.0.113.24 (or CNAME → ec2-…)". */
export function dnsHint(e) {
  if (!e?.dns?.expect || e.dns.text === 'Verified') return '';
  return html`<p class="inf-note" data-dns-hint>Add at your DNS host: <span class="inf-mono">${e.dns.expect.type} ${e.dns.expect.name} → ${e.dns.expect.value}</span>${e.dns.alt ? html` (or <span class="inf-mono">${e.dns.alt.type} → ${e.dns.alt.value}</span>)` : ''}. We check every minute; the certificate follows on its own.</p>`;
}

/**
 * The form. `vm` names the VM and its cloud address; `e` is the endpoint being changed (its address kind is fixed) or
 * null for a new one.
 */
export function endpointForm({ vm, e = null }) {
  const address = e?.address ?? 'cloud';
  const cert = e?.certSource ?? 'letsencrypt';
  const cloudText = vm.cloud === 'aws'
    ? 'Its public DNS name. Served over HTTP, and HTTPS with a self-signed certificate that browsers warn about.'
    : 'Its static IP. Served over HTTP, and HTTPS with a self-signed certificate that browsers warn about.';
  return html`<form class="inf-form" data-form="endpoint"${e ? html` data-id="${e.id}" data-address="${e.address}"` : ''} novalidate aria-label="${e ? `Change ${e.host}${e.path === '/' ? '' : e.path}` : 'Add an endpoint'}">
    ${e ? html`<p class="inf-muted">Address: <span class="inf-mono">${e.host}</span></p>` : optionCards({
      name: 'address',
      legend: 'Address',
      value: address,
      items: [
        { value: 'cloud', title: 'Use the cloud’s address', text: html`${vm.cloudAddress ? html`<span class="inf-mono">${vm.cloudAddress}</span><br>` : ''}${cloudText}` },
        { value: 'domain', title: 'Use my own domain', text: 'A trusted certificate from Let’s Encrypt, or one you upload. You add one DNS record.' },
      ],
    })}
    <div class="inf-form__row">
      ${field({ name: 'domain', label: 'Domain', hidden: address !== 'domain', control: html`<input class="inf-input inf-mono" name="domain" placeholder="shop.example.com" autocomplete="off" spellcheck="false" value="${e?.address === 'domain' ? e.host : ''}"${address !== 'domain' ? html` disabled` : ''}${describedBy('domain')}>`, help: 'You will add an A record for it.' })}
      ${field({ name: 'path', label: 'Path', control: html`<input class="inf-input inf-mono" name="path" value="${e?.path ?? '/'}" autocomplete="off" spellcheck="false"${describedBy('path')}>`, help: 'Several apps can share an address: /, /blog, /api.' })}
      ${field({ name: 'port', label: 'Traffic port', control: html`<input class="inf-input" type="number" name="port" min="1" max="65535" step="1" inputmode="numeric" value="${e?.port ?? 3000}" required${describedBy('port')}>`, help: 'Where the app listens on the VM.' })}
    </div>
    <div data-domain-only${address !== 'domain' ? html` hidden` : ''}>
      ${field({ name: 'cert', label: 'Certificate', control: html`<select class="inf-input" name="cert"${address !== 'domain' ? html` disabled` : ''}${describedBy('cert')}><option value="letsencrypt"${cert === 'letsencrypt' ? html` selected` : ''}>Free, renews itself (Let’s Encrypt)</option><option value="upload"${cert === 'upload' ? html` selected` : ''}>Upload my own</option></select>`, wrap: 'inf-field--narrow' })}
      <div class="inf-form__row" data-upload${cert !== 'upload' ? html` hidden` : ''}>
        ${field({ name: 'certificate', label: 'Certificate (PEM, with its chain)', control: html`<textarea class="inf-input inf-mono" name="certificate" rows="4" spellcheck="false"${cert !== 'upload' ? html` disabled` : ''}${describedBy('certificate')}></textarea>`, help: e?.certSource === 'upload' ? 'Leave empty to keep the one uploaded.' : '-----BEGIN CERTIFICATE-----' })}
        ${field({ name: 'privateKey', label: 'Private key (PEM)', control: html`<textarea class="inf-input inf-mono" name="privateKey" rows="4" spellcheck="false" autocomplete="off"${cert !== 'upload' ? html` disabled` : ''}${describedBy('privateKey')}></textarea>`, help: 'Kept encrypted; never shown again.' })}
      </div>
      ${switchRow({ name: 'redirectHttp', title: 'Redirect HTTP to HTTPS', text: 'Visitors on http:// are sent to https://.', checked: e ? e.redirectHttp : true })}
    </div>
    <span class="inf-error" data-error="address" aria-live="polite"></span>
    <div class="actions"><button class="btn btn--primary" type="submit">${e ? 'Save endpoint' : 'Add endpoint'}</button><button class="btn btn--secondary" type="button" data-action="endpoint-cancel">Cancel</button></div>
  </form>`;
}

/** Shows the domain-only and upload-only parts for what is picked now, and turns off the hidden controls. */
export function syncEndpointForm(form) {
  // A change keeps its address kind (data-address); a new endpoint follows the radio.
  const isDomain = (form.dataset.address ?? form.querySelector('[name="address"]:checked')?.value) === 'domain';
  const toggle = (el, on) => {
    if (!el) return;
    el.hidden = !on;
    for (const c of el.querySelectorAll('input, select, textarea')) c.disabled = !on;
  };
  toggle(form.querySelector('[data-field="domain"]'), isDomain);
  toggle(form.querySelector('[data-domain-only]'), isDomain);
  const upload = isDomain && form.querySelector('[name="cert"]')?.value === 'upload';
  toggle(form.querySelector('[data-upload]'), upload);
}

/** What the form sends: numbers as numbers, an empty upload left out (a change keeps the certificate). */
export function endpointBody(values) {
  const body = { ...values };
  if (body.port !== undefined) body.port = Number(body.port);
  if (body.certificate === '') delete body.certificate;
  if (body.privateKey === '') delete body.privateKey;
  return body;
}
