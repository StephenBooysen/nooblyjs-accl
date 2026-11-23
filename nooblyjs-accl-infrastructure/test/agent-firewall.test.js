// Spec 8.9 R14, the egress firewall: the rules, applying them (again) without duplicates, the status the agent reports,
// the operators' warning, and the relays' own port range. The real thing, on this machine's iptables and Docker, runs
// with NOOBLY_REAL_FIREWALL=1 (it needs sudo without a password, and changes the firewall while it runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { firewallRules, applyFirewall, removeFirewall, firewallStatus, FORWARD_CHAIN, INPUT_CHAIN, PRIVATE_RANGES, RELAY_PORTS } from '../agent/firewall.js';
import { createRelays, RELAY_PORT, RELAY_PORT_SPAN } from '../agent/relay.js';
import { serverFacts, exec } from '../agent/docker.js';
import { startApp } from './helpers.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'noobly-fw-'));

test('R14 the rules: the internet yes; private ranges, metadata and the server no; DNS, replies, other bridges and the relays on their gateway yes', () => {
  const { chains, hooks } = firewallRules();
  const forward = chains[FORWARD_CHAIN].map((r) => r.join(' '));
  assert.equal(forward[0], '-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN', 'replies first');
  assert.deepEqual(forward.slice(1, 3), ['-o br-+ -j RETURN', '-o docker0 -j RETURN'], 'bridge to bridge is Docker\'s isolation to decide');
  assert.ok(forward.includes('-p udp --dport 53 -j RETURN'));
  for (const cidr of PRIVATE_RANGES) assert.ok(forward.includes(`-d ${cidr} -j REJECT --reject-with icmp-admin-prohibited`), cidr);
  assert.ok(PRIVATE_RANGES.includes('169.254.0.0/16'), 'cloud metadata');
  assert.equal(forward.at(-1), '-j RETURN', 'the rest (the internet) goes on to Docker\'s own rules');
  assert.ok(forward.indexOf('-p udp --dport 53 -j RETURN') < forward.indexOf('-d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited'), 'a private resolver still answers');

  const input = chains[INPUT_CHAIN].map((r) => r.join(' '));
  assert.equal(input[0], '-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN');
  assert.ok(input.includes(`-p tcp --dport ${RELAY_PORTS} -m addrtype --dst-type LOCAL --limit-iface-in -j RETURN`), 'the relays, on the gateway only');
  assert.equal(RELAY_PORTS, `${RELAY_PORT}:${RELAY_PORT + RELAY_PORT_SPAN}`);
  assert.equal(input.at(-1), '-j REJECT --reject-with icmp-admin-prohibited', 'nothing else on the server');

  assert.deepEqual(hooks.map((h) => `${h.chain} ${h.rule.join(' ')}`), [
    `DOCKER-USER -i br-+ -j ${FORWARD_CHAIN}`, `DOCKER-USER -i docker0 -j ${FORWARD_CHAIN}`,
    `INPUT -i br-+ -j ${INPUT_CHAIN}`, `INPUT -i docker0 -j ${INPUT_CHAIN}`,
  ]);
});

test('R14 applying again replaces the rules and never doubles a hook; the status is readable; remove takes it all out', async () => {
  const stateDir = await tmp();
  const rules = new Map(); // chain → rule strings (a pretend iptables)
  const calls = [];
  const run = async (cmd, args) => {
    assert.equal(cmd, 'iptables');
    assert.equal(args[0], '-w', 'waits for the xtables lock');
    const [op, chain, ...rest] = args.slice(1);
    calls.push(`${op} ${chain}`);
    const list = rules.get(chain);
    const rule = (op === '-I' ? rest.slice(1) : rest).join(' ');
    const ok = { code: 0, stdout: '', stderr: '' };
    const no = { code: 1, stdout: '', stderr: 'No chain/target/match by that name.' };
    switch (op) {
      case '-N': if (list) return { ...no, stderr: 'Chain already exists.' }; rules.set(chain, []); return ok;
      case '-F': if (!list) return no; list.length = 0; return ok;
      case '-X': if (!list) return no; rules.delete(chain); return ok;
      case '-A': list.push(rule); return ok;
      case '-I': list.splice(Number(rest[0]) - 1, 0, rule); return ok;
      case '-C': return list?.includes(rule) ? ok : no;
      case '-D': { const i = list?.indexOf(rule) ?? -1; if (i < 0) return no; list.splice(i, 1); return ok; }
      default: throw new Error(op);
    }
  };
  rules.set('INPUT', ['-i lo -j ACCEPT']);
  const at = new Date('2026-11-23T08:00:00Z');
  const first = await applyFirewall({ stateDir, run, now: () => at });
  assert.deepEqual(first, { applied: true, version: 1, at: at.toISOString(), relayPorts: RELAY_PORTS });
  const once = JSON.stringify([...rules]);
  await applyFirewall({ stateDir, run, now: () => at });
  assert.equal(JSON.stringify([...rules]), once, 'the same rules, no second copy of a hook');
  assert.equal(rules.get('INPUT').filter((r) => r.endsWith(INPUT_CHAIN)).length, 2);
  assert.equal(rules.get('INPUT').at(-1), '-i lo -j ACCEPT', 'the server\'s own rules stay, after ours');
  assert.equal(rules.get(FORWARD_CHAIN).length, firewallRules().chains[FORWARD_CHAIN].length);

  const mode = (await fs.stat(path.join(stateDir, 'firewall.json'))).mode & 0o777;
  assert.equal(mode, 0o644, 'the agent (not root) reads it');
  assert.deepEqual(await firewallStatus(stateDir), { applied: true, version: 1, at: at.toISOString() });
  assert.equal((await serverFacts({ stateDir, docker: 'false' })).egressFirewall.applied, true, 'in the agent\'s facts');

  await removeFirewall({ stateDir, run });
  assert.deepEqual(rules.get('INPUT'), ['-i lo -j ACCEPT']);
  assert.deepEqual(rules.get('DOCKER-USER'), []);
  assert.equal(rules.has(FORWARD_CHAIN) || rules.has(INPUT_CHAIN), false);
  assert.equal((await firewallStatus(stateDir)).applied, false);
  assert.deepEqual(await firewallStatus(await tmp()), { applied: false, version: null, at: null }, 'never applied');

  // A failing iptables (not root, no iptables) is an error that names the rule, not a silent half-applied firewall.
  await assert.rejects(applyFirewall({ stateDir, run: async () => ({ code: 4, stdout: '', stderr: 'Permission denied (you must be root)' }) }), /iptables .*Permission denied/);
});

test('R14 operators see a warning for a server whose agent says it has no egress firewall', async () => {
  const t = await startApp({ platform: { enabled: true }, local: { site: { id: 'lan-dev', name: 'Local network' }, agent: 'mock' }, agents: { checkMs: 0 } });
  try {
    await t.hosted.local.agent.welcome;
    const servers = t.hosted.local.servers;
    let [server] = await servers.servers();
    for (let i = 0; i < 100 && !server?.facts; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      [server] = await servers.servers();
    }
    assert.equal(server.warnings.some((w) => /egress firewall/.test(w)), false, 'the mock agent has one');
    const updated = await servers.recordFacts(server.id, { ...server.facts, egressFirewall: { applied: false, version: null, at: null } });
    assert.match(updated.warnings.find((w) => /egress firewall/.test(w)), /^No egress firewall: tenant containers and builds can reach this server and its private network/);
    const older = await servers.recordFacts(server.id, { ...server.facts, egressFirewall: undefined });
    assert.equal(older.warnings.some((w) => /egress firewall/.test(w)), false, 'an agent that does not report it (cloud pool hosts) is not warned about');
  } finally {
    await t.close();
  }
});

test('R14 a relay listens on its own ports on the gateway, never on the database\'s port', async () => {
  const stateDir = await tmp();
  const target = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const relays = createRelays({ stateDir, targets: [`127.0.0.1:${target.address().port}`], inspect: async () => ({ gateway: '127.0.0.1', subnet: '127.0.0.0/8' }) });
  try {
    const r = await relays.ensure({ network: 'n', target: `127.0.0.1:${target.address().port}`, databases: ['db_1'] });
    assert.ok(r.port >= RELAY_PORT && r.port <= RELAY_PORT + RELAY_PORT_SPAN, `port ${r.port}`);
  } finally {
    await relays.remove({ network: 'n' });
    await new Promise((r) => target.close(r));
  }
});

const real = process.env.NOOBLY_REAL_FIREWALL === '1';
test('R14 for real: a tenant container reaches the internet and its relay port on the gateway, and nothing else on the server', { skip: !real && 'NOOBLY_REAL_FIREWALL=1 (sudo, iptables, Docker)', timeout: 240_000 }, async () => {
  const stateDir = await tmp();
  const node = process.execPath;
  const bin = new URL('../agent/bin/noobly-agent.js', import.meta.url).pathname;
  const host = Object.values(os.networkInterfaces()).flat().find((n) => n?.family === 'IPv4' && !n.internal && !/^(172\.1[7-9]|172\.2\d|172\.3[01])\./.test(n.address))?.address;
  assert.ok(host, 'this machine has a private address');
  const listen = (port, address) => new Promise((resolve) => { const s = net.createServer((c) => c.end('hi\n')); s.listen(port, address, () => resolve(s)); });
  const service = await listen(18089, '0.0.0.0'); // something on the server, on every address
  const relayLike = await listen(RELAY_PORT + 7, '0.0.0.0'); // a relay port, also on every address
  const network = `noobly-fw-test-${process.pid}`;
  try {
    assert.equal((await exec('sudo', ['-n', node, bin, 'firewall', 'apply', '--state-dir', stateDir])).code, 0);
    assert.equal((await exec('docker', ['network', 'create', network])).code, 0);
    const gw = JSON.parse((await exec('docker', ['network', 'inspect', '-f', '{{json (index .IPAM.Config 0).Gateway}}', network])).stdout);
    const probe = async (addr, port) => (await exec('docker', ['run', '--rm', '--network', network, '--cap-drop', 'ALL', 'alpine:3.20', 'nc', '-z', '-w', '3', addr, String(port)])).code === 0;
    assert.equal(await probe(host, 18089), false, 'the server, on its private address');
    assert.equal(await probe(gw, 18089), false, 'the server, on the gateway');
    assert.equal(await probe(host, RELAY_PORT + 7), false, 'a relay port, but not on the gateway');
    assert.equal(await probe(gw, RELAY_PORT + 7), true, 'a relay port on the gateway');
    assert.equal(await probe('example.com', 443), true, 'the internet');
  } finally {
    await exec('docker', ['network', 'rm', network]);
    await exec('sudo', ['-n', node, bin, 'firewall', 'remove', '--state-dir', stateDir]);
    service.close();
    relayLike.close();
  }
});
