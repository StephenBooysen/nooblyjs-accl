// Public HTTPS endpoints on a VM (product.md §6.3–6.4; architecture.md §9 "Endpoints"; roadmap phase 3). An endpoint
// sends an address (the cloud's own, or the person's domain) and a path to a port on the VM, through the Caddy every VM
// runs. The records are what was asked for; an operation on the VM makes its Caddy match them: ports 80 and 443 open
// while it has endpoints, uploaded certificates in place, one site file per address, and a first DNS check. Two jobs
// keep the pills current: the DNS check (Waiting for DNS record → Verified) and the certificate check (Pending → Valid,
// with its expiry, read from Caddy).
//
// Who may: adding, changing and removing an endpoint need `draft` (product.md §7).
import crypto from 'node:crypto';
import { HttpError, notFound, unprocessable, conflict } from '../util/errors.js';
import { needs } from '../util/http.js';
import { newId, isGeneratedId, isResourceName } from '../util/ids.js';
import { CloudError, isCloudError } from '../providers/errors.js';
import { who } from './operations.js';
import { renderSites, isHostName, isIpv4, isEndpointPath, isTrafficPort } from '../remote/caddy.js';
import { firewallRules } from './steps/vm.js';

export const ENDPOINT_OPERATIONS = ['endpoint.add', 'endpoint.change', 'endpoint.remove'];
/** Ports 80 and 443 from anywhere, while a VM has at least one endpoint (roadmap 3.4). */
export const WEB_RULES = [{ port: 80, from: '0.0.0.0/0', why: 'https' }, { port: 443, from: '0.0.0.0/0', why: 'https' }];
const MINUTE = 60_000;
/** A certificate still missing an hour after its DNS was verified is shown as failed (Caddy keeps trying). */
const CERT_PATIENCE_MS = 60 * MINUTE;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const LIVE = new Set(['active', 'adding', 'changing']);

/** Whether an endpoint is in the VM's Caddy (or on its way there). */
const served = (e) => LIVE.has(e.status ?? 'active');

export function createEndpoints({ repos, host, operations, providers, remote, dns, secrets, now, log }) {
  const iso = () => new Date(now()).toISOString();
  const emit = (type, e, vm, extra = {}, actor = null) => host.events.emit(type, {
    resource: { type: 'vm', name: e.vm }, account: vm?.account ?? null, endpoint: e.id, host: e.host, path: e.path, vm: e.vm, ...extra,
  }, { actor });
  const forVm = async (name) => (await repos.endpoints.list()).filter((e) => e.vm === name);

  // ---------------------------------------------------------------- what the VM's Caddy should hold

  async function withRunner(vm, account, fn) {
    const runner = await remote.forVm(vm, account);
    try {
      return await fn(runner);
    } finally {
      runner.close();
    }
  }

  const parse = (result) => {
    try {
      return JSON.parse(String(result.stdout ?? '').trim().split('\n').pop());
    } catch {
      return null;
    }
  };

  /** Ports: SSH as launched, plus 80 and 443 while the VM has an endpoint. */
  async function syncPorts(ctx, vm) {
    const eps = (await forVm(vm.name)).filter(served);
    await ctx.provider.compute.setFirewall(vm.ref.instance, [...firewallRules(vm.spec), ...(eps.length ? WEB_RULES : [])]);
    await ctx.log(eps.length ? 'Ports 80 and 443 are open' : 'Ports 80 and 443 are closed: no endpoints left');
  }

  /** Uploaded certificates: sent over SFTP and put in place, once per certificate. */
  async function syncCertificates(ctx, vm) {
    const pending = (await forVm(vm.name)).filter((e) => served(e) && e.cert?.source === 'upload' && e.cert.installed !== e.cert.fingerprint);
    if (!pending.length) return false;
    await withRunner(vm, ctx.account, async (runner) => {
      for (const e of pending) {
        const pem = await secrets.get(e.cert.ref);
        if (!pem?.certificate || !pem?.privateKey) throw new CloudError('invalid', `The certificate for ${e.host} is no longer stored. Upload it again.`);
        await runner.put(`${e.id}.crt`, pem.certificate, { mode: 0o600 });
        await runner.put(`${e.id}.key`, pem.privateKey, { mode: 0o600 });
        const result = await runner.run('caddy-cert', [e.id, `${e.id}.crt`, `${e.id}.key`], { signal: ctx.signal });
        if (result.code !== 0) throw new CloudError('unavailable', parse(result)?.message ?? `The certificate for ${e.host} could not be put in place.`);
        await repos.endpoints.update(e.id, (r) => r && { ...r, cert: { ...r.cert, installed: r.cert.fingerprint } });
        await ctx.log(`Installed the uploaded certificate for ${e.host}`);
      }
    });
    return true;
  }

  /** Site files: one per address, written when changed, removed when its last endpoint goes; Caddy reloads each time. */
  async function syncSites(ctx, vm) {
    const sites = renderSites((await forVm(vm.name)).filter(served));
    const written = { ...(vm.proxy?.sites ?? {}) };
    const record = (patch) => repos.vms.update(vm.name, (r) => r && { ...r, proxy: { ...(r.proxy ?? {}), sites: patch } });
    await withRunner(vm, ctx.account, async (runner) => {
      for (const [address, text] of sites) {
        const digest = sha(text);
        if (written[address] === digest) continue;
        const staged = `site-${address}.caddy`;
        await runner.put(staged, text, { mode: 0o644 });
        const result = await runner.run('caddy-site', [address, staged], { signal: ctx.signal });
        if (result.code !== 0) throw new CloudError('invalid', parse(result)?.message ?? `Caddy did not take the site for ${address}.`);
        written[address] = digest;
        await record(written);
        await ctx.log(`${address} is configured`);
      }
      for (const address of Object.keys(written)) {
        if (sites.has(address)) continue;
        const result = await runner.run('caddy-remove', [address], { signal: ctx.signal });
        if (result.code !== 0) throw new CloudError('unavailable', parse(result)?.message ?? `Caddy did not let go of ${address}.`);
        delete written[address];
        await record(written);
        await ctx.log(`${address} is no longer served`);
      }
    });
  }

  /** One DNS check of the VM's domains now; the DNS job carries on from there. */
  async function checkDnsFor(vm, account) {
    const lookup = dns.forAccount(account);
    const ip = vm.observed?.publicIp ?? null;
    const changed = [];
    for (const e of (await forVm(vm.name)).filter((x) => served(x) && x.dns && x.dns.status !== 'verified')) {
      let addresses = [];
      try {
        addresses = await lookup.lookup(e.host);
      } catch (err) {
        log.warn(`DNS lookup of ${e.host}: ${err.message}`);
      }
      const verified = Boolean(ip) && addresses.includes(ip);
      const next = await repos.endpoints.update(e.id, (r) => r && { ...r, dns: { ...r.dns, status: verified ? 'verified' : 'waiting', checkedAt: iso(), seen: addresses.slice(0, 4), ...(verified ? { verifiedAt: iso() } : {}) } });
      if (verified && next) changed.push(next);
    }
    for (const e of changed) await emit('infrastructure.endpoint.dns_verified', e, vm);
    return changed.length;
  }

  // ---------------------------------------------------------------- operations

  const syncSteps = [
    {
      key: 'ports',
      label: 'Open ports 80 and 443',
      async run(ctx) {
        const vm = await vmOf(ctx);
        await syncPorts(ctx, vm);
        return {};
      },
    },
    {
      key: 'certificates',
      label: 'Install certificates',
      async run(ctx) {
        const did = await syncCertificates(ctx, await vmOf(ctx));
        return did ? {} : { skipped: true, reason: 'no uploaded certificate to install' };
      },
    },
    {
      key: 'sites',
      label: 'Configure the HTTPS proxy',
      async run(ctx) {
        await syncSites(ctx, await vmOf(ctx));
        return {};
      },
    },
    {
      key: 'dns',
      label: 'Check DNS',
      async run(ctx) {
        const vm = await vmOf(ctx);
        const waiting = (await forVm(vm.name)).filter((e) => served(e) && e.dns && e.dns.status !== 'verified');
        if (!waiting.length) return { skipped: true, reason: 'nothing waits for DNS' };
        const verified = await checkDnsFor(vm, ctx.account);
        await ctx.log(verified ? `DNS verified for ${verified} address${verified === 1 ? '' : 'es'}` : 'Waiting for the DNS record; checked again every minute');
        return {};
      },
    },
  ];
  const vmOf = async (ctx) => {
    const vm = await repos.vms.get(ctx.op.resource.name);
    if (!vm?.ref?.instance) throw new CloudError('not_found', `${ctx.op.resource.name} is no longer there.`);
    return vm;
  };

  /** After a sync: what was added or changed is active, what was removed goes, certificates Caddy issues at once show. */
  async function settle(ctx) {
    const vm = await repos.vms.get(ctx.op.resource.name);
    for (const e of await forVm(ctx.op.resource.name)) {
      if (e.status === 'removing') {
        if (e.cert?.ref) await secrets.remove(e.cert.ref);
        await repos.endpoints.remove(e.id);
        if (e.id === ctx.input.endpoint) await emit('infrastructure.endpoint.removed', e, vm, {}, ctx.op.requestedBy?.id);
        continue;
      }
      if (e.status !== 'adding' && e.status !== 'changing') continue;
      const next = await repos.endpoints.update(e.id, (r) => r && {
        ...r,
        status: 'active',
        failure: null,
        previous: undefined,
        // Caddy makes the cloud address's own certificate at once; an uploaded one is valid from now.
        cert: r.cert.source === 'internal' && r.cert.status === 'pending' ? { ...r.cert, status: 'self-signed' }
          : r.cert.source === 'upload' ? { ...r.cert, status: Date.parse(r.cert.expiresAt) > now() ? 'valid' : 'expired' } : r.cert,
      });
      if (next && e.id === ctx.input.endpoint) await emit(e.status === 'adding' ? 'infrastructure.endpoint.added' : 'infrastructure.endpoint.changed', next, vm, {}, ctx.op.requestedBy?.id);
    }
  }

  /** A failed sync: an endpoint being added is marked failed (and left out of Caddy), a change or removal is undone. */
  async function unsettle(ctx) {
    const reason = ctx.op.error?.message ?? 'The endpoint could not be configured.';
    for (const e of await forVm(ctx.op.resource.name)) {
      if (e.status === 'adding') await repos.endpoints.update(e.id, (r) => r && { ...r, status: 'failed', failure: reason });
      else if (e.status === 'changing') await repos.endpoints.update(e.id, (r) => r && { ...r, ...(r.previous ?? {}), previous: undefined, status: 'active', failure: reason });
      else if (e.status === 'removing') await repos.endpoints.update(e.id, (r) => r && { ...r, status: 'active', failure: reason });
    }
  }

  const label = { 'endpoint.add': 'Add', 'endpoint.change': 'Change', 'endpoint.remove': 'Remove' };
  for (const type of ENDPOINT_OPERATIONS) {
    operations.define(type, {
      label: (op) => `${label[type]} endpoint ${op.input.host ?? ''} on ${op.resource.name}`.replace('  ', ' '),
      verb: type === 'endpoint.remove' ? 'Removing' : 'Configuring',
      steps: syncSteps,
      succeeded: settle,
      failed: unsettle,
      cancelled: unsettle,
    });
  }

  // ---------------------------------------------------------------- checking what is asked

  /** The cloud's own address for a VM: AWS's public DNS name, or GCP's static IP. */
  async function cloudAddress(vm, account) {
    const provider = await providers.forAccount(account);
    return provider.compute.defaultAddress(vm.ref?.instance);
  }

  /** The DNS records to add for a domain, once the VM's static IP is known. */
  function dnsFor(domain, vm, account, cloudName) {
    const ip = vm.observed?.publicIp ?? null;
    return {
      status: 'waiting',
      checkedAt: null,
      expect: ip ? { type: 'A', name: domain, value: ip } : null,
      alt: account?.cloud === 'aws' && cloudName && cloudName !== ip ? { type: 'CNAME', name: domain, value: cloudName } : null,
    };
  }

  /** An uploaded certificate: its chain parses, it names the domain, its key matches, and it has not expired. */
  function checkUpload(body, domain, fields) {
    const certificate = typeof body.certificate === 'string' ? body.certificate.trim() : '';
    const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';
    if (!certificate) fields.certificate = 'Paste the certificate (PEM), with its chain.';
    if (!privateKey) fields.privateKey = 'Paste the private key (PEM).';
    if (fields.certificate || fields.privateKey) return null;
    let x509;
    try {
      x509 = new crypto.X509Certificate(certificate);
    } catch {
      fields.certificate = 'This is not a PEM certificate.';
      return null;
    }
    let key;
    try {
      key = crypto.createPrivateKey(privateKey);
    } catch {
      fields.privateKey = 'This is not a PEM private key.';
      return null;
    }
    if (!x509.checkPrivateKey(key)) fields.privateKey = 'This key does not belong to the certificate.';
    if (domain && !x509.checkHost(domain)) fields.certificate = `This certificate is not for ${domain}.`;
    if (Date.parse(x509.validTo) <= now()) fields.certificate = `This certificate expired on ${new Date(x509.validTo).toDateString()}.`;
    if (fields.certificate || fields.privateKey) return null;
    return {
      certificate: `${certificate}\n`,
      privateKey: `${privateKey}\n`,
      expiresAt: new Date(x509.validTo).toISOString(),
      issuer: x509.issuer.split('\n').find((l) => l.startsWith('O=') || l.startsWith('CN='))?.replace(/^(O|CN)=/, '') ?? null,
      fingerprint: x509.fingerprint256,
    };
  }

  /**
   * The fields of an endpoint from what a person sent. `existing` is the endpoint being changed (its address kind and
   * VM are fixed). Throws 422 with a message per field.
   */
  async function validate(body, vm, account, { existing = null } = {}) {
    const fields = {};
    const address = existing?.address ?? body.address;
    if (!['cloud', 'domain'].includes(address)) fields.address = 'Pick the cloud’s address or your own domain.';
    const domain = address === 'domain' ? String(body.domain ?? existing?.host ?? '').trim().toLowerCase().replace(/\.$/, '') : null;
    if (address === 'domain') {
      if (!domain) fields.domain = 'Type the domain, such as shop.example.com.';
      else if (isIpv4(domain)) fields.domain = 'Type a domain, not an address. To use the VM’s address, pick the cloud’s address.';
      else if (!isHostName(domain)) fields.domain = 'A domain such as shop.example.com: letters, digits, dots and dashes.';
      else if (/(^|\.)(amazonaws\.com|googleusercontent\.com)$/.test(domain)) fields.domain = 'That is the cloud’s own name: pick the cloud’s address instead.';
    }
    const path = body.path === undefined || body.path === '' ? existing?.path ?? '/' : String(body.path).trim().replace(/\/+$/, '') || '/';
    if (!isEndpointPath(path)) fields.path = 'A path such as / or /blog: letters, digits, dots, dashes and slashes.';
    const port = body.port === undefined || body.port === '' ? existing?.port : Number(body.port);
    if (!isTrafficPort(port)) fields.port = 'The port the app listens on, from 1 to 65535 (not 22, 80, 443 or 2019).';
    const redirectHttp = address === 'domain' ? (body.redirectHttp === undefined ? existing?.redirectHttp ?? true : body.redirectHttp === true || body.redirectHttp === 'true') : false;
    const source = address === 'cloud' ? 'internal' : (body.cert ?? existing?.cert?.source ?? 'letsencrypt');
    if (address === 'domain' && !['letsencrypt', 'upload'].includes(source)) fields.cert = 'Pick Let’s Encrypt or upload your own.';
    const newUpload = source === 'upload' && (body.certificate !== undefined || body.privateKey !== undefined || existing?.cert?.source !== 'upload' || (domain && domain !== existing?.host));
    const upload = newUpload ? checkUpload(body, domain, fields) : null;
    const app = body.app === undefined ? existing?.app ?? null : body.app;
    if (app !== null && !isResourceName(app)) fields.app = 'An app’s name.';
    if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields.', { fields });

    // The address: the cloud's own name for the VM, or the domain.
    const host_ = address === 'cloud' ? existing?.host ?? await cloudAddress(vm, account) : domain;
    if (!host_) throw new HttpError(409, 'conflict', `${vm.name} has no public address yet.`);
    const others = (await repos.endpoints.list()).filter((e) => e.id !== existing?.id && e.status !== 'failed');
    const elsewhere = others.find((e) => e.host === host_ && e.vm !== vm.name);
    if (elsewhere) throw conflict(`${host_} is already in use on ${elsewhere.vm}.`, { fields: { domain: `${host_} is already in use on ${elsewhere.vm}.` } });
    const same = others.filter((e) => e.host === host_ && e.vm === vm.name);
    if (same.some((e) => (e.path ?? '/') === path)) throw unprocessable(`${host_}${path === '/' ? '' : path} is already routed.`, { fields: { path: `${path} on ${host_} already goes somewhere. Pick another path.` } });
    // Endpoints sharing an address share its certificate and its redirect (one Caddy site).
    if (same.length && address === 'domain' && !existing) {
      const lead = same[0];
      if (lead.cert?.source !== source || (lead.redirectHttp !== false) !== redirectHttp) {
        throw unprocessable(`${host_} already has endpoints; they share one certificate and one HTTP setting.`, {
          fields: { cert: `Use ${lead.cert?.source === 'upload' ? 'the uploaded certificate' : 'Let’s Encrypt'} and ${lead.redirectHttp !== false ? 'redirect HTTP to HTTPS' : 'keep serving HTTP'}, as ${host_}’s other endpoints do.` },
        });
      }
    }
    return { address, host: host_, path, port, redirectHttp, source, upload, app };
  }

  async function mustVm(name, { running = true } = {}) {
    const vm = isResourceName(name) ? await repos.vms.get(name) : null;
    if (!vm || vm.role === 'database') throw notFound(`No VM ${name}.`);
    if (vm.missing) throw new HttpError(409, 'conflict', `${name} is no longer in the cloud.`);
    if (running && vm.status !== 'running') throw new HttpError(409, 'conflict', `${name} is ${vm.status}. Start it to change its endpoints.`);
    return vm;
  }

  async function mustGet(id) {
    const e = isGeneratedId(id) ? await repos.endpoints.get(id) : null;
    if (!e) throw notFound(`No endpoint ${id}.`);
    return e;
  }

  async function busy(name) {
    const op = (await operations.list({ resource: `vm:${name}`, status: 'active' }))[0];
    if (op) throw new HttpError(409, 'conflict', `${name} is busy: ${op.label} (${op.statusText}). Wait for it to finish.`, { operation: op.id });
  }

  /** A record's cert block from what validate() found. */
  async function certOf(fields, existing = null) {
    if (fields.source === 'internal') return { source: 'internal', status: existing?.cert?.source === 'internal' ? existing.cert.status : 'pending' };
    if (fields.source === 'upload') {
      if (!fields.upload) return existing.cert;
      const ref = await secrets.put('certificate', { certificate: fields.upload.certificate, privateKey: fields.upload.privateKey });
      return { source: 'upload', status: 'pending', ref, expiresAt: fields.upload.expiresAt, issuer: fields.upload.issuer, fingerprint: fields.upload.fingerprint, installed: null };
    }
    const keep = existing?.cert?.source === 'letsencrypt' && existing.host === fields.host;
    return keep ? existing.cert : { source: 'letsencrypt', status: 'pending' };
  }

  // ---------------------------------------------------------------- views

  /** How an endpoint reads on the VM's page and in the lists. */
  function view(e, vm) {
    const running = vm?.status === 'running' && !vm?.missing;
    const cert = e.cert ?? {};
    const certView = cert.status === 'valid' ? { text: 'Valid', tone: 'success', expiresAt: cert.expiresAt ?? null }
      : cert.status === 'self-signed' ? { text: 'Self-signed', tone: 'neutral', expiresAt: null }
        : cert.status === 'failed' ? { text: 'Failed', tone: 'danger', expiresAt: null }
          : cert.status === 'expired' ? { text: 'Expired', tone: 'danger', expiresAt: cert.expiresAt ?? null }
            : { text: 'Pending', tone: 'warning', expiresAt: null };
    const dnsView = !e.dns ? { text: 'Not needed', tone: 'neutral' }
      : e.dns.status === 'verified' ? { text: 'Verified', tone: 'success' } : { text: 'Waiting for DNS record', tone: 'warning' };
    const usable = running && (e.status ?? 'active') === 'active' && (cert.status === 'valid' || cert.status === 'self-signed');
    const statusText = { adding: 'Configuring', changing: 'Configuring', removing: 'Removing', failed: 'Failed' }[e.status] ?? null;
    return {
      id: e.id,
      vm: e.vm,
      address: e.address ?? 'domain',
      host: e.host,
      path: e.path ?? '/',
      url: usable ? `https://${e.host}${e.path && e.path !== '/' ? `${e.path}/` : ''}` : null,
      httpUrl: running && e.address === 'cloud' && (e.status ?? 'active') === 'active' ? `http://${e.host}${e.path && e.path !== '/' ? `${e.path}/` : ''}` : null,
      app: e.app ?? null,
      port: e.port ?? null,
      redirectHttp: e.redirectHttp !== false,
      certSource: cert.source ?? 'letsencrypt',
      cert: certView,
      dns: { ...dnsView, expect: e.dns?.expect ?? null, alt: e.dns?.alt ?? null, checkedAt: e.dns?.checkedAt ?? null },
      status: e.status ?? 'active',
      statusText,
      failure: e.failure ?? null,
      paused: Boolean(vm) && !running,
      note: vm && vm.status === 'stopped' ? 'Paused while stopped' : null,
      can: { change: running && !['adding', 'changing', 'removing'].includes(e.status ?? 'active'), remove: running && e.status !== 'removing' },
    };
  }

  // ---------------------------------------------------------------- jobs

  async function runningVmsWith(filter) {
    const out = [];
    const eps = (await repos.endpoints.list()).filter((e) => served(e) && filter(e));
    for (const name of new Set(eps.map((e) => e.vm))) {
      const vm = await repos.vms.get(name);
      if (!vm || vm.status !== 'running' || vm.missing || !vm.ref?.instance) continue;
      const account = await repos.accounts.get(vm.account);
      if (account) out.push({ vm, account });
    }
    return out;
  }

  return {
    view,
    forVm,

    async list({ vm } = {}) {
      const vms = new Map((await repos.vms.list()).map((v) => [v.name, v]));
      return (await repos.endpoints.list())
        .filter((e) => !vm || e.vm === vm)
        .sort((a, b) => a.host.localeCompare(b.host) || String(a.path).localeCompare(String(b.path)))
        .map((e) => view(e, vms.get(e.vm)));
    },

    async get(id) {
      const e = await mustGet(id);
      return view(e, await repos.vms.get(e.vm));
    },

    /** Adds an endpoint to a running VM and queues endpoint.add. → { endpoint, operation } */
    async add(vmName, body, person) {
      await needs(host, person, 'draft', `add an endpoint to ${vmName}`);
      const vm = await mustVm(vmName);
      await busy(vmName);
      const account = await repos.accounts.get(vm.account);
      const f = await validate(body ?? {}, vm, account);
      const cloudName = f.address === 'domain' && account?.cloud === 'aws' ? await cloudAddress(vm, account).catch(() => null) : null;
      // Another path on an address the VM already serves shares its DNS record and its certificate.
      const sibling = f.source !== 'upload' ? (await forVm(vm.name)).find((e) => e.host === f.host && served(e) && e.status !== 'adding') : null;
      const record = {
        id: newId('ep'), vm: vm.name, app: f.app, address: f.address, host: f.host, path: f.path, port: f.port, redirectHttp: f.redirectHttp,
        cert: sibling ? { ...sibling.cert } : await certOf(f),
        dns: f.address === 'domain' ? (sibling?.dns ? { ...sibling.dns } : dnsFor(f.host, vm, account, cloudName)) : null,
        status: 'adding', failure: null, createdAt: iso(), createdBy: who(person),
      };
      await repos.endpoints.write(record);
      const operation = await operations.start('endpoint.add', { resource: { type: 'vm', name: vm.name }, account: vm.account, input: { endpoint: record.id, host: record.host }, person });
      return { endpoint: view(record, vm), operation };
    },

    /** Changes an endpoint's domain, path, port, redirect or certificate, and queues endpoint.change. */
    async change(id, body, person) {
      const e = await mustGet(id);
      await needs(host, person, 'draft', `change the endpoint ${e.host}`);
      const vm = await mustVm(e.vm);
      await busy(vm.name);
      if (['adding', 'changing', 'removing'].includes(e.status)) throw new HttpError(409, 'conflict', `${e.host} is being configured. Wait for it to finish.`);
      const account = await repos.accounts.get(vm.account);
      const f = await validate(body ?? {}, vm, account, { existing: e });
      const cloudName = f.address === 'domain' && account?.cloud === 'aws' ? await cloudAddress(vm, account).catch(() => null) : null;
      const previous = { host: e.host, path: e.path, port: e.port, redirectHttp: e.redirectHttp, cert: e.cert, dns: e.dns, app: e.app ?? null };
      const next = await repos.endpoints.update(id, (r) => r && {
        ...r, host: f.host, path: f.path, port: f.port, redirectHttp: f.redirectHttp, app: f.app,
        dns: f.address === 'domain' ? (f.host === r.host ? r.dns : dnsFor(f.host, vm, account, cloudName)) : null,
        status: e.status === 'failed' ? 'adding' : 'changing', failure: null, previous: e.status === 'failed' ? undefined : previous,
      });
      const cert = await certOf(f, e);
      const updated = await repos.endpoints.update(id, (r) => r && { ...r, cert });
      const operation = await operations.start(next.status === 'adding' ? 'endpoint.add' : 'endpoint.change', { resource: { type: 'vm', name: vm.name }, account: vm.account, input: { endpoint: id, host: f.host }, person });
      return { endpoint: view(updated, vm), operation };
    },

    /** Removes an endpoint; its address stops being served when it was the last on it. */
    async remove(id, person) {
      const e = await mustGet(id);
      await needs(host, person, 'draft', `remove the endpoint ${e.host}`);
      const vm = await repos.vms.get(e.vm);
      if (e.status === 'failed' || !vm || vm.status !== 'running') {
        // Never in Caddy (a failed add), or nothing to talk to: the record just goes.
        if (vm && vm.status !== 'running' && e.status !== 'failed') throw new HttpError(409, 'conflict', `${e.vm} is ${vm.status}. Start it to remove its endpoints.`);
        if (e.cert?.ref) await secrets.remove(e.cert.ref);
        await repos.endpoints.remove(id);
        return { endpoint: null, operation: null };
      }
      await busy(vm.name);
      if (e.status === 'removing') throw new HttpError(409, 'conflict', `${e.host} is already being removed.`);
      await repos.endpoints.update(id, (r) => r && { ...r, status: 'removing' });
      const operation = await operations.start('endpoint.remove', { resource: { type: 'vm', name: vm.name }, account: vm.account, input: { endpoint: id, host: e.host }, person });
      return { endpoint: view({ ...e, status: 'removing' }, vm), operation };
    },

    /**
     * vm.launch's third step (roadmap 3.4): the endpoint asked for at launch now gets its address (the VM's static IP
     * is known), its ports, its site file and its first DNS check.
     */
    async launchStep(ctx) {
      const vm = await vmOf(ctx);
      const eps = (await forVm(vm.name)).filter((e) => e.status === 'adding');
      if (!eps.length) return { skipped: true, reason: 'no public endpoint' };
      const provider = ctx.provider;
      const cloudName = await provider.compute.defaultAddress(vm.ref.instance);
      for (const e of eps) {
        await repos.endpoints.update(e.id, (r) => r && (r.address === 'cloud'
          ? { ...r, host: cloudName }
          : { ...r, dns: dnsFor(r.host, vm, ctx.account, cloudName) }));
      }
      await syncPorts(ctx, vm);
      await syncSites(ctx, await vmOf(ctx));
      await checkDnsFor(await vmOf(ctx), ctx.account);
      await settle({ ...ctx, input: { endpoint: eps[0].id } });
      return {};
    },

    /**
     * An app's endpoint (apps.js, the "Go live" step of app.deploy, inside the operation on the VM): added the first
     * time, pointed at the new container after (`upstreamPort`, its port on 127.0.0.1; `port` stays the app's own),
     * then the VM's Caddy is made to match (ports, certificates, the site file, a first DNS check). `spec` is
     * { address: 'cloud' | 'domain', domain, path }. → the endpoint
     */
    async forApp(ctx, app, { upstreamPort, spec }) {
      let vm = await vmOf(ctx);
      let e = (await forVm(vm.name)).find((x) => x.app === app.name && x.status !== 'removing');
      if (!e) {
        const cloudName = await ctx.provider.compute.defaultAddress(vm.ref.instance);
        e = {
          id: newId('ep'), vm: vm.name, app: app.name, address: spec.address, host: spec.address === 'cloud' ? cloudName : spec.domain,
          path: spec.path || '/', port: app.run?.port ?? upstreamPort, upstreamPort, redirectHttp: spec.address === 'domain',
          cert: spec.address === 'cloud' ? { source: 'internal', status: 'pending' } : { source: 'letsencrypt', status: 'pending' },
          dns: spec.address === 'domain' ? dnsFor(spec.domain, vm, ctx.account, cloudName) : null,
          status: 'adding', failure: null, createdAt: iso(), createdBy: ctx.op.requestedBy ?? null,
        };
        await repos.endpoints.write(e);
      } else if (e.upstreamPort !== upstreamPort) {
        e = await repos.endpoints.update(e.id, (r) => r && { ...r, upstreamPort, ...((r.status ?? 'active') === 'active' ? { status: 'changing', previous: { upstreamPort: r.upstreamPort } } : {}) });
      }
      await syncPorts(ctx, vm);
      await syncCertificates(ctx, vm);
      vm = await vmOf(ctx);
      await syncSites(ctx, vm);
      await checkDnsFor(await vmOf(ctx), ctx.account);
      await settle({ ...ctx, input: { endpoint: e.id } });
      return repos.endpoints.get(e.id);
    },

    /** An app's endpoint goes (app.delete, inside the operation on the VM): out of Caddy, ports closed with the last. */
    async removeForApp(ctx, appName) {
      const vm = await vmOf(ctx);
      const mine = (await forVm(vm.name)).filter((x) => x.app === appName);
      if (!mine.length) return false;
      for (const e of mine) await repos.endpoints.update(e.id, (r) => r && { ...r, status: 'removing' });
      await syncPorts(ctx, vm);
      await syncSites(ctx, await vmOf(ctx));
      await settle({ ...ctx, input: { endpoint: mine[0].id } });
      return true;
    },

    /** Whether host + path is free for a new endpoint (an app's form checks before deploying). */
    async isFree(hostName, path = '/') {
      return !(await repos.endpoints.list()).some((e) => e.host === hostName && (e.path ?? '/') === path && e.status !== 'failed');
    },

    /** The endpoint asked for at launch, written with the VM (its address is filled in by launchStep). */
    async forLaunch(vmName, spec, person) {
      if (!spec) return null;
      const record = {
        id: newId('ep'), vm: vmName, app: null, address: spec.address, host: spec.address === 'domain' ? spec.domain : null, path: '/', port: spec.port,
        redirectHttp: spec.address === 'domain' ? spec.redirectHttp !== false : false,
        cert: spec.address === 'cloud' ? { source: 'internal', status: 'pending' } : { source: 'letsencrypt', status: 'pending' },
        dns: spec.address === 'domain' ? { status: 'waiting', checkedAt: null, expect: null, alt: null } : null,
        status: 'adding', failure: null, createdAt: iso(), createdBy: who(person),
      };
      await repos.endpoints.write(record);
      return record;
    },

    /** The launch form's endpoint, checked like an added one (without a VM yet). Returns { endpoint } or fields. */
    async checkLaunch(body, fields) {
      if (!body || body.enabled === false || body.enabled === 'false') return null;
      const address = body.address;
      if (!['cloud', 'domain'].includes(address)) fields['endpoint.address'] = 'Pick the cloud’s address or your own domain.';
      const port = Number(body.port);
      if (!isTrafficPort(port)) fields['endpoint.port'] = 'The port the app listens on, from 1 to 65535 (not 22, 80, 443 or 2019).';
      let domain = null;
      if (address === 'domain') {
        domain = String(body.domain ?? '').trim().toLowerCase().replace(/\.$/, '');
        if (!isHostName(domain)) fields['endpoint.domain'] = 'A domain such as shop.example.com.';
        else if ((await repos.endpoints.list()).some((e) => e.host === domain && e.status !== 'failed')) fields['endpoint.domain'] = `${domain} is already in use.`;
      }
      return { address, port, domain, redirectHttp: body.redirectHttp !== false && body.redirectHttp !== 'false' };
    },

    /** A deleted VM's endpoints, and their uploaded certificates. */
    async removeForVm(vmName) {
      for (const e of await forVm(vmName)) {
        if (e.cert?.ref) await secrets.remove(e.cert.ref);
        await repos.endpoints.remove(e.id);
      }
    },

    /** The DNS job: every waiting domain on a running VM, looked up again. */
    async checkDns() {
      let verified = 0;
      for (const { vm, account } of await runningVmsWith((e) => e.dns && e.dns.status !== 'verified')) verified += await checkDnsFor(vm, account);
      return verified;
    },

    /**
     * The certificate job (roadmap 3.5): what Caddy holds on each running VM with endpoints. Let's Encrypt certificates
     * go Pending → Valid with their expiry; one still missing an hour after its DNS was verified shows as Failed.
     */
    async checkCerts() {
      for (const { vm, account } of await runningVmsWith((e) => e.cert?.source !== 'upload')) {
        let certs;
        try {
          certs = await withRunner(vm, account, async (runner) => {
            const result = await runner.run('caddy-certs', []);
            if (result.code !== 0) throw new CloudError('unavailable', `${vm.name} did not say which certificates it holds.`);
            return parse(result)?.certs ?? [];
          });
        } catch (err) {
          if (!isCloudError(err)) log.warn(`certificates on ${vm.name}: ${err.message}`);
          continue;
        }
        const byHost = new Map(certs.map((c) => [c.host, c]));
        for (const e of (await forVm(vm.name)).filter((x) => served(x) && x.cert?.source !== 'upload')) {
          const c = byHost.get(e.host);
          let cert = e.cert;
          if (e.cert.source === 'internal' && c) cert = { ...e.cert, status: 'self-signed', expiresAt: c.expiresAt };
          else if (e.cert.source === 'letsencrypt' && c && c.issuer !== 'local') cert = { ...e.cert, status: 'valid', expiresAt: c.expiresAt, checkedAt: iso() };
          else if (e.cert.source === 'letsencrypt' && !c && e.dns?.status === 'verified' && now() - Date.parse(e.dns.verifiedAt ?? e.dns.checkedAt ?? iso()) > CERT_PATIENCE_MS) cert = { ...e.cert, status: 'failed' };
          if (JSON.stringify(cert) === JSON.stringify(e.cert)) continue;
          const next = await repos.endpoints.update(e.id, (r) => r && { ...r, cert });
          if (next && cert.status === 'valid' && e.cert.status !== 'valid') await emit('infrastructure.endpoint.certificate', next, vm, { expiresAt: cert.expiresAt });
        }
      }
      // Uploaded certificates expire on their own date.
      for (const e of (await repos.endpoints.list()).filter((x) => x.cert?.source === 'upload' && x.cert.status === 'valid' && Date.parse(x.cert.expiresAt) <= now())) {
        await repos.endpoints.update(e.id, (r) => r && { ...r, cert: { ...r.cert, status: 'expired' } });
      }
    },

    /** How often the jobs run: every minute while something waits, else every 15 minutes (DNS) and 6 hours (certificates). */
    async dnsEvery() {
      return (await repos.endpoints.list()).some((e) => served(e) && e.dns && e.dns.status !== 'verified') ? MINUTE : 15 * MINUTE;
    },
    async certsEvery() {
      return (await repos.endpoints.list()).some((e) => served(e) && e.cert?.status === 'pending') ? MINUTE : 360 * MINUTE;
    },
  };
}
