// What each Noobly Cloud event says (architecture.md §7). Every event this accelerator emits goes through withWords(),
// which adds `system: 'infrastructure'` and the sentence the launcher's Activity shows ("Stevie" + "connected GCP
// account stevie-prod"), and records the ones worth keeping in this accelerator's activity log, with the verb pill
// and the short text the Overview shows ("Deployed" · "storefront a1f3c9e to web-01"). `quiet` events (an operation's
// progress) are emitted but not kept.

export const CLOUD = { gcp: 'GCP', aws: 'AWS' };
const KIND = { vm: 'VM', app: 'app', database: 'database', bucket: 'bucket', account: 'account', workload: 'workload', git: 'Git connection' };
const cloudOf = (p) => CLOUD[p.cloud] ?? p.cloud ?? 'the cloud';
const resourceOf = (p) => `${KIND[p.resource?.type] ?? p.resource?.type ?? 'resource'} ${p.resource?.name ?? ''}`.trim();

/** type → { verb, tone, text(p), summary?(p) } or { quiet: true }. Tones are the kit's pill tones. */
const WORDS = {
  'infrastructure.operation.queued': { quiet: true },
  'infrastructure.operation.started': { quiet: true },
  'infrastructure.operation.progress': { quiet: true },
  'infrastructure.operation.succeeded': { quiet: true },
  'infrastructure.operation.failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `${p.label}${p.stepLabel ? ` at “${p.stepLabel}”` : ''}`,
    summary: (p) => `could not finish “${p.label}”: ${p.reason}`,
  },
  'infrastructure.operation.cancelled': { verb: 'Cancelled', tone: 'neutral', text: (p) => p.label, summary: (p) => `cancelled “${p.label}”` },

  'infrastructure.account.connected': { verb: 'Connected', tone: 'success', text: (p) => `${cloudOf(p)} account ${p.name}` },
  'infrastructure.account.needs_attention': {
    verb: 'Attention', tone: 'danger',
    text: (p) => `${cloudOf(p)} account ${p.name}: ${p.reason}`,
    summary: (p) => `found that ${cloudOf(p)} account ${p.name} needs attention: ${p.reason}`,
  },
  'infrastructure.account.changed': { verb: 'Changed', tone: 'neutral', text: (p) => `${cloudOf(p)} account ${p.name}` },
  'infrastructure.account.removed': { verb: 'Removed', tone: 'neutral', text: (p) => `${cloudOf(p)} account ${p.name}` },

  'infrastructure.resource.missing': {
    verb: 'Missing', tone: 'danger',
    text: (p) => `${resourceOf(p)} is no longer in ${cloudOf(p)}`,
    summary: (p) => `found that ${resourceOf(p)} is no longer in ${cloudOf(p)}`,
  },
  'infrastructure.resource.changed': {
    verb: 'Changed', tone: 'warning',
    text: (p) => `${resourceOf(p)} is ${p.status} in ${cloudOf(p)}, changed outside Noobly Cloud`,
    summary: (p) => `found that ${resourceOf(p)} was changed outside Noobly Cloud: it is ${p.status}`,
  },

  // The resources' own events. Their operations arrive in roadmap phases 2–6; the seed story already uses them.
  // Created when the launch is asked for (the Overview shows "Created" while the VM is still starting); Ready when it
  // is up and its first boot has finished.
  'infrastructure.vm.created': { verb: 'Created', tone: 'info', text: (p) => `VM ${p.name} · ${cloudOf(p)} ${p.region}` },
  'infrastructure.vm.ready': {
    verb: 'Ready', tone: 'success',
    text: (p) => `VM ${p.name}${p.ip ? ` at ${p.ip}` : ''}`,
    summary: (p) => `launched VM ${p.name}${p.ip ? `, up at ${p.ip}` : ''}`,
  },
  'infrastructure.vm.started': { verb: 'Started', tone: 'success', text: (p) => `VM ${p.name}` },
  'infrastructure.vm.restarted': { verb: 'Restarted', tone: 'success', text: (p) => `VM ${p.name}` },
  'infrastructure.vm.stopped': { verb: 'Stopped', tone: 'neutral', text: (p) => `VM ${p.name}` },
  'infrastructure.vm.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `VM ${p.name}` },
  // Public HTTPS endpoints (roadmap phase 3). Their resource is the VM they are on.
  'infrastructure.endpoint.added': { verb: 'Added', tone: 'success', text: (p) => `endpoint ${p.host}${p.path && p.path !== '/' ? p.path : ''} on ${p.vm}` },
  'infrastructure.endpoint.changed': { verb: 'Changed', tone: 'neutral', text: (p) => `endpoint ${p.host}${p.path && p.path !== '/' ? p.path : ''} on ${p.vm}` },
  'infrastructure.endpoint.removed': { verb: 'Removed', tone: 'neutral', text: (p) => `endpoint ${p.host}${p.path && p.path !== '/' ? p.path : ''} from ${p.vm}` },
  'infrastructure.endpoint.dns_verified': {
    verb: 'Verified', tone: 'success',
    text: (p) => `DNS for ${p.host} points at ${p.vm}`,
    summary: (p) => `saw the DNS record for ${p.host} point at ${p.vm}`,
  },
  'infrastructure.endpoint.certificate': {
    verb: 'Certificate', tone: 'success',
    text: (p) => `${p.host} has a Let’s Encrypt certificate${p.expiresAt ? ` until ${String(p.expiresAt).slice(0, 10)}` : ''}`,
    summary: (p) => `saw Let’s Encrypt issue a certificate for ${p.host}`,
  },
  'infrastructure.app.building': {
    verb: 'Building', tone: 'warning',
    text: (p) => `${p.app} ${p.commit} on ${p.vm}`,
    summary: (p) => `started building ${p.app} ${p.commit} on ${p.vm}`,
  },
  'infrastructure.app.deployed': { verb: 'Deployed', tone: 'success', text: (p) => `${p.app} ${p.commit} to ${p.vm}` },
  'infrastructure.app.created': { verb: 'Created', tone: 'info', text: (p) => `app ${p.app} from ${p.repo} on ${p.vm}` },
  'infrastructure.app.deploy_failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `${p.app}${p.commit ? ` ${p.commit}` : ''} on ${p.vm}: ${p.reason}`,
    summary: (p) => `could not deploy ${p.app}${p.commit ? ` ${p.commit}` : ''} to ${p.vm}: ${p.reason}`,
  },
  'infrastructure.app.stopped': { verb: 'Stopped', tone: 'neutral', text: (p) => `${p.app} on ${p.vm}` },
  'infrastructure.app.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `app ${p.app} from ${p.vm}` },
  'infrastructure.app.crashed': {
    verb: 'Crashed', tone: 'danger',
    text: (p) => `${p.app} on ${p.vm}: ${p.reason}`,
    summary: (p) => `found ${p.app} crashed on ${p.vm} (${p.reason})`,
  },
  'infrastructure.git.connected': { verb: 'Connected', tone: 'success', text: (p) => `${p.label ?? p.provider} as ${p.user}` },
  'infrastructure.git.needs_attention': {
    verb: 'Attention', tone: 'danger',
    text: (p) => `Git connection ${p.resource?.name}: ${p.reason}`,
    summary: (p) => `found that the Git connection ${p.resource?.name} needs attention: ${p.reason}`,
  },
  'infrastructure.git.removed': { verb: 'Removed', tone: 'neutral', text: (p) => `Git connection ${p.resource?.name}` },
  'infrastructure.database.created': { verb: 'Created', tone: 'info', text: (p) => `database ${p.name} · ${cloudOf(p)} ${p.region}` },
  'infrastructure.database.backed_up': {
    verb: 'Backup', tone: 'success',
    text: (p) => `${p.name} · ${p.size} snapshot`,
    summary: (p) => `backed up ${p.name} (${p.size})`,
  },
  // The platform layer (spec 8.1): a launcher's tenants' workloads. `tenantId` names whose.
  'infrastructure.workload.created': { verb: 'Created', tone: 'info', text: (p) => `${p.kind} ${p.workload} for ${p.tenantId}` },
  'infrastructure.workload.updated': { verb: 'Changed', tone: 'neutral', text: (p) => `${p.workload} for ${p.tenantId}${p.changed?.length ? ` (${p.changed.join(', ')})` : ''}` },
  'infrastructure.job.started': { verb: 'Running', tone: 'info', text: (p) => `${p.workload} for ${p.tenantId} (${p.trigger})` },
  'infrastructure.job.succeeded': { verb: 'Ran', tone: 'success', text: (p) => `${p.workload} for ${p.tenantId}: exit code ${p.exitCode}` },
  'infrastructure.job.failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `run of ${p.workload} for ${p.tenantId}`,
    summary: (p) => `the run of ${p.workload} for ${p.tenantId} failed: ${p.reason}`,
  },
  'infrastructure.workload.scale_failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `scale of ${p.workload} for ${p.tenantId}`,
    summary: (p) => `could not scale ${p.workload} for ${p.tenantId}: ${p.reason}${p.reverted ? ` (back to ${p.instances})` : ''}`,
  },
  'infrastructure.workload.instances': {
    verb: 'Instances', tone: 'warning',
    text: (p) => ({
      unknown: `${p.workload} for ${p.tenantId}: ${p.instance} is unreachable (server ${p.server} is offline)`,
      back: `${p.workload} for ${p.tenantId}: ${p.instance} is serving again (server ${p.server} is back)`,
      moved: `${p.workload} for ${p.tenantId}: ${p.instance} moved off ${p.server} to ${p.to} as ${p.name}`,
      stuck: `${p.workload} for ${p.tenantId}: ${p.instance} could not move off ${p.server}: ${p.reason}`,
    })[p.change] ?? `${p.workload} for ${p.tenantId}: ${p.change}`,
  },
  'infrastructure.instance.crashed': {
    verb: 'Crashed', tone: 'danger',
    text: (p) => `${p.workload} for ${p.tenantId}: ${p.instance} exited${p.exitCode !== null && p.exitCode !== undefined ? ` with code ${p.exitCode}` : ''}${p.gaveUp ? ' and was not restarted again (5 restarts)' : `; restarted (${p.restarts} of 5)`}`,
    summary: (p) => `saw ${p.instance} of ${p.workload} exit${p.gaveUp ? ' for good' : ''}`,
  },
  // Host pools (spec 8.2): the shared VMs a region's instances run on.
  'infrastructure.pool.created': { verb: 'Created', tone: 'info', text: (p) => `host pool ${p.pool} in ${p.region} (${p.min}–${p.max} hosts)` },
  'infrastructure.pool.grown': { verb: 'Added', tone: 'success', text: (p) => `host ${p.vm} to pool ${p.pool}` },
  'infrastructure.pool.drained': { verb: 'Drained', tone: 'neutral', text: (p) => `host ${p.vm} of pool ${p.pool}${p.moved ? ` (${p.moved} instance${p.moved === 1 ? '' : 's'} moved)` : ''}` },
  'infrastructure.pool.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `host pool ${p.pool}` },
  'infrastructure.workload.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `${p.workload} for ${p.tenantId}` },
  'infrastructure.workload.domain_verified': { verb: 'Verified', tone: 'success', text: (p) => `${p.domain} for ${p.workload} of ${p.tenantId}: its DNS points at the ingress` },
  'infrastructure.workload.status': {
    verb: 'Status', tone: 'neutral',
    text: (p) => `${p.workload} for ${p.tenantId} is ${p.status}`,
    summary: (p) => `saw ${p.workload} for ${p.tenantId} become ${p.status}`,
  },
  'infrastructure.deploy.started': {
    verb: 'Building', tone: 'warning',
    text: (p) => `${p.workload}${p.commit ? ` ${p.commit}` : ''} for ${p.tenantId}`,
    summary: (p) => `started deploying ${p.workload}${p.commit ? ` ${p.commit}` : ''} for ${p.tenantId}`,
  },
  'infrastructure.deploy.progress': { quiet: true },
  'infrastructure.deploy.succeeded': { verb: 'Deployed', tone: 'success', text: (p) => `${p.workload}${p.commit ? ` ${p.commit}` : ''} for ${p.tenantId}` },
  'infrastructure.deploy.failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `deploy of ${p.workload}${p.commit ? ` ${p.commit}` : ''} for ${p.tenantId}`,
    summary: (p) => `could not deploy ${p.workload}${p.commit ? ` ${p.commit}` : ''} for ${p.tenantId}: ${p.reason}`,
  },
  'infrastructure.database.status': {
    verb: 'Status', tone: 'neutral',
    text: (p) => `database ${p.database} for ${p.tenantId} is ${p.status}`,
    summary: (p) => `saw database ${p.database} for ${p.tenantId} become ${p.status}${p.reason ? `: ${p.reason}` : ''}`,
  },
  'infrastructure.database.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `database ${p.database} for ${p.tenantId}` },
  'infrastructure.database.backed_up': { verb: 'Backed up', tone: 'success', text: (p) => `database ${p.database} for ${p.tenantId}` },
  'infrastructure.database.backup_failed': {
    verb: 'Failed', tone: 'danger',
    text: (p) => `backup of database ${p.database} for ${p.tenantId}`,
    summary: (p) => `could not back up database ${p.database} for ${p.tenantId}: ${p.reason}`,
  },
  'infrastructure.keyvalue.status': {
    verb: 'Status', tone: 'neutral',
    text: (p) => `Key Value ${p.keyvalue} for ${p.tenantId} is ${p.status}`,
    summary: (p) => `saw Key Value ${p.keyvalue} for ${p.tenantId} become ${p.status}${p.reason ? `: ${p.reason}` : ''}`,
  },
  'infrastructure.keyvalue.deleted': { verb: 'Deleted', tone: 'neutral', text: (p) => `Key Value ${p.keyvalue} for ${p.tenantId}` },
  'infrastructure.bucket.created': { verb: 'Created', tone: 'info', text: (p) => `bucket ${p.name} · ${cloudOf(p)} ${p.region}` },
};

/** The words for an event: { verb, tone, text, summary }, { quiet: true }, or null when it has none. */
export function words(type, payload = {}) {
  const w = WORDS[type];
  if (!w) return null;
  if (w.quiet) return { quiet: true };
  const text = w.text(payload);
  return { verb: w.verb, tone: w.tone, text, summary: w.summary ? w.summary(payload) : `${w.verb.toLowerCase()} ${text}` };
}

/**
 * The launcher's `events`, with every emit from this accelerator named and worded, and kept in the activity log when
 * `record` is given. A failure to record never fails the emit.
 */
export function withWords(events, { record, log } = {}) {
  return {
    ...events,
    async emit(type, payload = {}, options) {
      const w = words(type, payload);
      const said = payload.summary || !w || w.quiet ? {} : { summary: w.summary };
      const full = { system: 'infrastructure', ...payload, ...said };
      const event = await events.emit(type, full, options);
      if (record && w && !w.quiet) {
        await record({ type, payload: full, words: w, actor: options?.actor ?? null }).catch((err) => log?.warn(`activity: ${err.message}`));
      }
      return event;
    },
  };
}
