#!/usr/bin/env node
// noobly-agent (spec 8.9 R2, R3): runs on a local server and connects out to the controller.
//
//   noobly-agent run --controller <url> [--token <enr_…> | --token-file <file>] [--state-dir <dir>] [--dev]
//   noobly-agent status [--state-dir <dir>]
//   noobly-agent firewall apply|remove|status [--state-dir <dir>]   (apply and remove as root; spec 8.9 R14)
//
// The first run trades the one-time token for this server's credential and keeps it in <state-dir>/agent.json (0600);
// later runs say hello with it. --dev allows file:// sources (a development machine). Stops when the controller
// refuses it for good (a removed server, a used token); otherwise reconnects with backoff.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { connectForever } from '../connect.js';
import { createDocker, serverFacts } from '../docker.js';
import { AGENT_VERSION } from '../protocol.js';
import { applyFirewall, removeFirewall, firewallStatus, firewallRules } from '../firewall.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    controller: { type: 'string' },
    token: { type: 'string' },
    'token-file': { type: 'string' },
    'state-dir': { type: 'string', default: process.env.NOOBLY_AGENT_STATE ?? '/var/lib/noobly-agent' },
    dev: { type: 'boolean', default: false },
    // A database server this agent may relay tenant containers to (spec 8.6 R2): host:port, repeatable.
    'relay-target': { type: 'string', multiple: true, default: [] },
  },
});
const [command = 'run'] = positionals;
const stateDir = path.resolve(values['state-dir']);
const stateFile = path.join(stateDir, 'agent.json');
const log = {
  info: (m) => console.log(`${new Date().toISOString()} noobly-agent ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} noobly-agent ${m}`),
};

const readState = async () => JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '{}'));
async function writeState(state) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, stateFile);
}

if (command === 'status') {
  const s = await readState();
  console.log(JSON.stringify({ agentVersion: AGENT_VERSION, stateDir, enrolled: Boolean(s.server && s.credential), server: s.server ?? null, controller: s.controller ?? null }, null, 2));
  process.exit(0);
}
// The egress firewall (spec 8.9 R14): install.sh and the noobly-firewall unit run this as root.
if (command === 'firewall') {
  const action = positionals[1] ?? 'status';
  if (action === 'status') {
    console.log(JSON.stringify({ ...(await firewallStatus(stateDir)), rules: firewallRules() }, null, 2));
    process.exit(0);
  }
  if (!['apply', 'remove'].includes(action)) {
    console.error('Usage: noobly-agent firewall apply|remove|status [--state-dir <dir>]');
    process.exit(2);
  }
  if (process.getuid?.() !== 0) {
    console.error(`noobly-agent: firewall ${action} changes iptables: run it as root (sudo).`);
    process.exit(2);
  }
  try {
    if (action === 'apply') {
      const s = await applyFirewall({ stateDir });
      log.info(`egress firewall applied (database relays on the gateway, ports ${s.relayPorts})`);
    } else {
      await removeFirewall({ stateDir });
      log.info('egress firewall removed');
    }
    process.exit(0);
  } catch (err) {
    console.error(`noobly-agent: ${err.message}`);
    process.exit(1);
  }
}
if (command !== 'run') {
  console.error('Usage: noobly-agent run --controller <url> [--token <token> | --token-file <file>] [--state-dir <dir>] [--dev]');
  process.exit(2);
}

let state = await readState();
const controller = values.controller ?? state.controller;
if (!controller) {
  console.error('noobly-agent: --controller <url> is needed the first time.');
  process.exit(2);
}
let token = values.token ?? process.env.NOOBLY_AGENT_TOKEN ?? null;
if (!token && values['token-file']) token = (await fs.readFile(values['token-file'], 'utf8').catch(() => '')).trim() || null;
if (!(state.server && state.credential) && !token) {
  console.error('noobly-agent: not enrolled yet. Run it with the --token from Add server.');
  process.exit(2);
}

const docker = createDocker({ stateDir, relayTargets: values['relay-target'], log });
await docker.relays.restore();
const agent = connectForever({
  controller,
  dev: values.dev,
  docker,
  facts: () => serverFacts({ stateDir }),
  log,
  identity: () => (state.server && state.credential ? { server: state.server, credential: state.credential } : { token }),
  onWelcome: async (w) => {
    if (w.credential) {
      state = { controller, server: w.server, credential: w.credential, install: w.install, enrolledAt: new Date().toISOString() };
      await writeState(state);
      log.info(`enrolled as ${w.server}; the credential is in ${stateFile}`);
      // The token is spent; install.sh's copy of it goes.
      if (values['token-file']) await fs.rm(values['token-file'], { force: true }).catch(() => {});
      token = null;
    }
  },
});
const stop = () => agent.stop();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const { reason } = await agent.done;
log.info(`stopped: ${reason}`);
process.exit(reason === 'stopped' ? 0 : 1);
