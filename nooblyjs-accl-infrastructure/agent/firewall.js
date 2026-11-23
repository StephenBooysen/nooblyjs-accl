// The egress firewall (spec 8.9 R14): what tenant code may reach from a local server. Containers run on Docker bridge
// networks (one per tenant, `br-…`) and builds' RUN steps on the default bridge (`docker0`); without this, either can
// open connections to the server itself (sshd, the controller, a database bound beyond 127.0.0.1) and to every machine
// on its private network. With it:
//
//   - to the internet: allowed (packages, APIs);
//   - to private, link-local (cloud metadata at 169.254.169.254), shared, loopback and multicast ranges: refused;
//   - to the server itself: refused, except the database relays' own ports (15432–15452) on the network's gateway
//     (spec 8.6 R2), which check the source subnet and the database themselves;
//   - DNS (port 53): allowed, so a private resolver still answers names;
//   - to another Docker bridge (the same tenant's containers, or another's): left to Docker's own isolation;
//   - replies on connections opened from outside (LAN users reaching a published port): allowed.
//
// The rules match interfaces by pattern (`br-+`, `docker0`), so a tenant network made later is covered without the
// agent, which is not root, touching the firewall. `noobly-agent firewall apply` (run as root by install.sh and by the
// noobly-firewall systemd unit, at boot and whenever Docker restarts) writes them into two chains of our own, hooked
// from DOCKER-USER (forwarded traffic) and INPUT (traffic to the server); applying again replaces them.
// IPv4 only: the agent creates no IPv6 networks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from './docker.js';
import { RELAY_PORT, RELAY_PORT_SPAN } from './relay.js';

export const FIREWALL_VERSION = 1;
export const FORWARD_CHAIN = 'NOOBLY-EGRESS';
export const INPUT_CHAIN = 'NOOBLY-INPUT';
/** Interfaces tenant code sends from: user-defined bridges (tenant networks) and the default bridge (builds). */
export const TENANT_INTERFACES = ['br-+', 'docker0'];
/** Destinations tenant code may not reach (RFC 1918, RFC 6598, link-local and cloud metadata, loopback, multicast, reserved). */
export const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'];
/** The relays' ports on a gateway (relay.js), as iptables writes a range. */
export const RELAY_PORTS = `${RELAY_PORT}:${RELAY_PORT + RELAY_PORT_SPAN}`;

/**
 * The rules as iptables argument lists (no shell): each chain's rules in order, and the hooks that send tenant
 * traffic into them.
 */
export function firewallRules() {
  const established = ['-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'RETURN'];
  const dns = [['-p', 'udp', '--dport', '53', '-j', 'RETURN'], ['-p', 'tcp', '--dport', '53', '-j', 'RETURN']];
  const forward = [
    established,
    ...TENANT_INTERFACES.map((i) => ['-o', i, '-j', 'RETURN']),
    ...dns,
    ...PRIVATE_RANGES.map((cidr) => ['-d', cidr, '-j', 'REJECT', '--reject-with', 'icmp-admin-prohibited']),
    ['-j', 'RETURN'],
  ];
  const input = [
    established,
    ...dns,
    // The relays, and only on the address of the bridge the packet came in on (its gateway): `--limit-iface-in`
    // makes LOCAL mean "an address of this interface", so the server's other addresses stay closed on these ports.
    ['-p', 'tcp', '--dport', RELAY_PORTS, '-m', 'addrtype', '--dst-type', 'LOCAL', '--limit-iface-in', '-j', 'RETURN'],
    ['-j', 'REJECT', '--reject-with', 'icmp-admin-prohibited'],
  ];
  const hooks = [
    ...TENANT_INTERFACES.map((i) => ({ chain: 'DOCKER-USER', rule: ['-i', i, '-j', FORWARD_CHAIN] })),
    ...TENANT_INTERFACES.map((i) => ({ chain: 'INPUT', rule: ['-i', i, '-j', INPUT_CHAIN] })),
  ];
  return { chains: { [FORWARD_CHAIN]: forward, [INPUT_CHAIN]: input }, hooks };
}

/**
 * Applies the rules with `iptables` (needs root); applying again replaces them. Writes what it did to
 * <stateDir>/firewall.json, which the agent reports in its facts (spec 8.9 R4: a server without it gets a warning).
 * @param {{ stateDir: string, iptables?: string, run?: typeof exec, now?: () => Date }} o
 */
export async function applyFirewall({ stateDir, iptables = 'iptables', run = exec, now = () => new Date() }) {
  const ipt = async (args, { allowFail = false } = {}) => {
    const r = await run(iptables, ['-w', ...args]);
    if (r.code !== 0 && !allowFail) throw new Error(`iptables ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  };
  const { chains, hooks } = firewallRules();
  // DOCKER-USER exists once Docker has started; made here too so a boot-order race cannot skip the hooks.
  await ipt(['-N', 'DOCKER-USER'], { allowFail: true });
  for (const [chain, rules] of Object.entries(chains)) {
    await ipt(['-N', chain], { allowFail: true });
    await ipt(['-F', chain]);
    for (const rule of rules) await ipt(['-A', chain, ...rule]);
  }
  for (const { chain, rule } of hooks) {
    if (!(await ipt(['-C', chain, ...rule], { allowFail: true }))) await ipt(['-I', chain, '1', ...rule]);
  }
  const status = { applied: true, version: FIREWALL_VERSION, at: now().toISOString(), relayPorts: RELAY_PORTS };
  await writeStatus(stateDir, status);
  return status;
}

/** Takes the hooks and chains out again (noobly-agent firewall remove). */
export async function removeFirewall({ stateDir, iptables = 'iptables', run = exec }) {
  const ipt = (args) => run(iptables, ['-w', ...args]);
  for (const { chain, rule } of firewallRules().hooks) {
    while ((await ipt(['-D', chain, ...rule])).code === 0) { /* every copy */ }
  }
  for (const chain of [FORWARD_CHAIN, INPUT_CHAIN]) {
    await ipt(['-F', chain]);
    await ipt(['-X', chain]);
  }
  await writeStatus(stateDir, { applied: false, version: FIREWALL_VERSION, at: new Date().toISOString() });
}

async function writeStatus(stateDir, status) {
  // install.sh makes the state folder (noobly's, 0700) first; made here only when it is missing, readable so the agent
  // can read the status.
  // (root's umask is often 077, so the modes are set after, not only asked for.)
  if (await fs.mkdir(stateDir, { recursive: true })) await fs.chmod(stateDir, 0o755);
  const file = path.join(stateDir, 'firewall.json');
  await fs.writeFile(file, `${JSON.stringify(status, null, 2)}\n`);
  await fs.chmod(file, 0o644);
}

/** What the agent reports: { applied, version, at } from the last apply, or { applied: false } when there was none. */
export async function firewallStatus(stateDir) {
  try {
    const s = JSON.parse(await fs.readFile(path.join(stateDir, 'firewall.json'), 'utf8'));
    return { applied: s.applied === true, version: Number(s.version) || null, at: typeof s.at === 'string' ? s.at : null };
  } catch {
    return { applied: false, version: null, at: null };
  }
}
