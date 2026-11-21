// Tenant ids and workload names (spec 8.1). A tenant id is the launcher's opaque id (a NooblyJS Cloud workspace), up to
// 64 characters; it names a folder, so it is limited to characters that are safe in one. A workload's name is unique
// per tenant and is a DNS label.
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WORKLOAD = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const isTenantId = (id) => typeof id === 'string' && TENANT.test(id) && !id.includes('..');
export const isWorkloadName = (name) => typeof name === 'string' && WORKLOAD.test(name);
export const KINDS = ['service', 'private', 'worker', 'job', 'static'];
export const RUNTIMES = ['node22', 'python312', 'go123', 'dockerfile'];
export const STATUSES = ['live', 'deploying', 'failed', 'suspended', 'sleeping', 'deleting'];
/** Kinds that listen on a port. */
export const HTTP_KINDS = new Set(['service', 'private']);

/**
 * A workload's private name for its tenant's other workloads (spec 8.2 R5): <workload>.<tenant>.internal, the tenant id
 * made a DNS label (lower case; anything else becomes a hyphen; a hash when nothing is left).
 */
export function internalHost(tenantId, name) {
  let label = String(tenantId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  if (!label) label = [...String(tenantId)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
  return `${name}.${label}.internal`;
}
