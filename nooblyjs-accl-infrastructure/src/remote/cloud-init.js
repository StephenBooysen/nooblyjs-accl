// First boot (architecture.md §9): the cloud-init user-data every VM is launched with. The person's SSH key goes to the
// image's default user (ubuntu, debian, rocky); the install's control key to `noobly`, the user Noobly Cloud works as.
// Docker is installed when asked; Caddy, the HTTPS proxy, always (roadmap phase 3: every VM is ready for a public
// endpoint, and ports 80 and 443 open only when one is added). /var/lib/noobly/ready marks the end. Written as JSON,
// which is valid YAML, so nothing put in it can change its structure.
//
// A host pool's VM (spec 8.2) has no person's key: it runs the noobly agent, installed at first boot with a one-time
// enrolment token (valid for an hour, used once), which connects out to the controller. Its Docker runs with user
// namespaces (`userns-remap`, so root in a container is not root on the host) and live-restore.
import { mainCaddyfile, PLACEHOLDER_SITE, SITES_DIR, CERTS_DIR } from './caddy.js';

const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}( [^\n\r]{0,200})?$/;
export const isPublicKey = (key) => typeof key === 'string' && PUBLIC_KEY.test(key.trim());

/** How Docker is installed on each image family: the distribution's own package, or Docker's repository. */
const DOCKER = {
  apt: { packages: ['docker.io'], runcmd: [] },
  dnf: {
    packages: ['dnf-plugins-core'],
    runcmd: [['dnf', 'config-manager', '--add-repo', 'https://download.docker.com/linux/centos/docker-ce.repo'], ['dnf', 'install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io']],
  },
};

/** How Caddy is installed: the distribution's package (Ubuntu and Debian), or the Caddy project's COPR (Rocky). */
const CADDY = {
  apt: { packages: ['caddy', 'jq'], runcmd: [] },
  dnf: { packages: ['jq'], runcmd: [['dnf', 'install', '-y', 'dnf-command(copr)'], ['dnf', 'copr', 'enable', '-y', '@caddy/caddy'], ['dnf', 'install', '-y', 'caddy']] },
};

/** Where files Noobly Cloud sends over SFTP wait (site files, certificates) before a script moves them into place. */
export const STAGING = '/home/noobly/.noobly';

/** A host's Docker daemon (spec 8.2 R2): user namespaces on, containers kept through a daemon restart, logs capped. */
export const HOST_DAEMON = { 'userns-remap': 'default', 'live-restore': true, 'log-driver': 'local', 'log-opts': { 'max-size': '20m', 'max-file': '3' } };
const CONTROLLER = /^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._/-]*)?$/;
const TOKEN = /^enr_[A-Za-z0-9_-]{32,64}$/;

/**
 * @param {object} o
 * @param {string|null} o.personKey     the person's public key (none on a host pool's VM)
 * @param {string} o.controlKey    the install's control public key
 * @param {boolean} [o.docker]
 * @param {boolean} [o.proxy]       Caddy (true unless a VM must not have one, such as a database VM)
 * @param {string|null} [o.acmeEmail]  the email Let's Encrypt writes to about certificates (ACME_EMAIL)
 * @param {'apt'|'dnf'} [o.packages]  the image's package manager
 * @param {{ controller: string, token: string }|null} [o.agent]  a host pool's VM: install the agent and enrol it
 * @returns {string} #cloud-config user-data
 */
/**
 * Caddy on an ingress VM starts from the config its agent last loaded (spec 8.4). The wildcard certificate's DNS-01
 * challenge needs a Caddy built with the cloud's DNS module (caddy-dns/googleclouddns or caddy-dns/route53); see spec 8.4.
 */
export const INGRESS_DROP_IN = '[Service]\nExecStart=\nExecStart=/usr/bin/caddy run --environ --resume --config /etc/caddy/Caddyfile\n';

export function cloudInit({ personKey, controlKey, docker = true, proxy = true, acmeEmail = process.env.ACME_EMAIL || null, packages = 'apt', agent = null }) {
  if (!agent && !isPublicKey(personKey)) throw new Error('cloudInit: the person\'s key is not an SSH public key.');
  if (personKey && !isPublicKey(personKey)) throw new Error('cloudInit: the person\'s key is not an SSH public key.');
  if (!isPublicKey(controlKey)) throw new Error('cloudInit: the control key is not an SSH public key.');
  if (agent && (!CONTROLLER.test(agent.controller ?? '') || !TOKEN.test(agent.token ?? ''))) throw new Error('cloudInit: the agent needs the controller\'s URL and an enrolment token.');
  if (agent && !docker) throw new Error('cloudInit: a host runs Docker.');
  const install = DOCKER[packages] ?? DOCKER.apt;
  const caddy = CADDY[packages] ?? CADDY.apt;
  const config = {
    users: [
      'default',
      { name: 'noobly', gecos: 'Noobly Cloud', shell: '/bin/bash', sudo: 'ALL=(ALL) NOPASSWD:ALL', ssh_authorized_keys: [controlKey.trim()] },
    ],
    ...(personKey ? { ssh_authorized_keys: [personKey.trim()] } : {}),
    ssh_pwauth: false,
    package_update: true,
    packages: [...(docker ? install.packages : []), ...(proxy ? caddy.packages : [])],
    // Caddy's are deferred: written after the packages, so the caddy package's own Caddyfile doesn't replace ours. A
    // host's daemon.json is not: Docker must start with it.
    ...(proxy || agent ? {
      write_files: [
        ...(proxy ? [
          { path: '/etc/caddy/Caddyfile', content: mainCaddyfile({ email: acmeEmail }), permissions: '0644', defer: true },
          { path: `${SITES_DIR}/00-noobly.caddy`, content: PLACEHOLDER_SITE, permissions: '0644', defer: true },
        ] : []),
        ...(agent ? [{ path: '/etc/docker/daemon.json', content: `${JSON.stringify(HOST_DAEMON, null, 2)}\n`, permissions: '0644' }] : []),
        // An ingress VM (spec 8.4): its agent loads Caddy's config through the admin API; --resume keeps it over a restart.
        ...(agent && proxy ? [{ path: '/etc/systemd/system/caddy.service.d/noobly-ingress.conf', content: INGRESS_DROP_IN, permissions: '0644' }] : []),
      ],
    } : {}),
    runcmd: [
      ...(docker ? [...install.runcmd, ['systemctl', 'enable', '--now', 'docker'], ['usermod', '-aG', 'docker', 'noobly']] : []),
      ...(proxy ? [
        ...caddy.runcmd,
        ['install', '-d', '-m', '0755', SITES_DIR],
        ['install', '-d', '-m', '0750', '-g', 'caddy', CERTS_DIR],
        ['install', '-d', '-m', '0755', '-o', 'caddy', '-g', 'caddy', '/var/log/caddy'],
        ['install', '-d', '-m', '0700', '-o', 'noobly', '-g', 'noobly', STAGING],
        ...(agent ? [['systemctl', 'daemon-reload']] : []),
        ['systemctl', 'enable', 'caddy'],
        ['systemctl', 'restart', 'caddy'],
      ] : []),
      // The agent (spec 8.9 install.sh): it connects out, so the VM needs no inbound port for it.
      ...(agent ? [['bash', '-c', `set -o pipefail; curl -fsSL --retry 5 '${agent.controller}/agent/install.sh' | bash -s -- --token '${agent.token}' --controller '${agent.controller}' --install-node`]] : []),
      ['mkdir', '-p', '/var/lib/noobly'],
      ['touch', '/var/lib/noobly/ready'],
    ],
  };
  return `#cloud-config\n${JSON.stringify(config, null, 2)}\n`;
}
