// Placement (spec 8.2 R3, R4, "Placement"): which hosts get a workload's instances. A pure function over records, so it
// is unit tested without a cloud or an agent; the runtime calls it under its instances lock and reserves what it picks.
//
// A host fits an instance when the plan's memory fits in what is left of its allocatable memory, and enough of its
// allocatable CPU is left: all of the plan's CPU on a host pool (`cpuFloor: 1`, never beyond allocatable), a quarter of
// it on a LAN site (`cpuFloor: 0.25`, spec 8.9: a person's own servers may be over-committed on CPU, never on memory).
// Of the hosts that fit, an instance goes to the one with the fewest instances of the same workload (so a workload's
// instances land on different hosts when there are several), then the one least reserved after placing it (its CPU
// and memory shares added: spread),
// then by name, so the answer never depends on the order the hosts were listed in.

const EPSILON = 1e-9;

/**
 * @param {object} o
 * @param {{ id: string, name?: string, allocatable: { cpu: number, memoryMb: number }, draining?: boolean }[]} o.hosts
 *   the hosts that may take instances (online ones; a draining host takes none)
 * @param {{ host: string, cpu: number, memoryMb: number, workload?: string }[]} o.instances   what is reserved now
 * @param {{ cpu: number, memoryMb: number }} o.plan
 * @param {number} [o.count]        how many instances to place
 * @param {string} [o.workload]     the workload's key (tenant/name), for spreading its instances
 * @param {number} [o.cpuFloor]     the share of the plan's CPU that must be free on the host (1: never beyond allocatable)
 * @param {boolean} [o.canGrow]     whether the pool may grow by a host when they do not all fit
 * @returns {{ hosts: string[] } | { hosts: string[], missing: number, grow: true } | { hosts: string[], missing: number, full: true }}
 *   `hosts` has one host id per placed instance (a host may appear more than once)
 */
export function place({ hosts, instances = [], plan, count = 1, workload = null, cpuFloor = 1, canGrow = false }) {
  if (!plan || !(plan.cpu > 0) || !(plan.memoryMb > 0)) throw new Error('place() needs a plan with cpu and memoryMb.');
  const state = new Map();
  for (const h of hosts) {
    if (h.draining) continue;
    state.set(h.id, { host: h, cpu: 0, memoryMb: 0, same: 0 });
  }
  for (const i of instances) {
    const s = state.get(i.host);
    if (!s) continue;
    s.cpu += i.cpu;
    s.memoryMb += i.memoryMb;
    if (workload && i.workload === workload) s.same += 1;
  }
  const fits = (s) => s.memoryMb + plan.memoryMb <= s.host.allocatable.memoryMb + EPSILON
    && s.host.allocatable.cpu - s.cpu + EPSILON >= plan.cpu * cpuFloor;
  // How full the host would be: its CPU share plus its memory share after placing, so a bigger host wins a tie on one.
  const after = (s) => (s.host.allocatable.cpu > 0 ? (s.cpu + plan.cpu) / s.host.allocatable.cpu : Infinity)
    + (s.host.allocatable.memoryMb > 0 ? (s.memoryMb + plan.memoryMb) / s.host.allocatable.memoryMb : Infinity);
  const picks = [];
  for (let n = 0; n < count; n += 1) {
    const best = [...state.values()].filter(fits).sort((a, b) => a.same - b.same || after(a) - after(b)
      || String(a.host.name ?? a.host.id).localeCompare(String(b.host.name ?? b.host.id)))[0];
    if (!best) break;
    best.cpu += plan.cpu;
    best.memoryMb += plan.memoryMb;
    best.same += 1;
    picks.push(best.host.id);
  }
  const missing = count - picks.length;
  if (!missing) return { hosts: picks };
  return canGrow ? { hosts: picks, missing, grow: true } : { hosts: picks, missing, full: true };
}

/** Per host: what its instances reserve, and what is left of its allocatable (for the Platform screen). */
export function reservations(hosts, instances) {
  return hosts.map((h) => {
    const mine = instances.filter((i) => i.host === h.id);
    const cpu = Math.round(mine.reduce((s, i) => s + i.cpu, 0) * 100) / 100;
    const memoryMb = mine.reduce((s, i) => s + i.memoryMb, 0);
    return {
      id: h.id,
      instances: mine.length,
      reserved: { cpu, memoryMb },
      free: { cpu: Math.round((h.allocatable.cpu - cpu) * 100) / 100, memoryMb: h.allocatable.memoryMb - memoryMb },
    };
  });
}
