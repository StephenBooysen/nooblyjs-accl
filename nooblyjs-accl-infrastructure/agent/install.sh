#!/usr/bin/env bash
# Installs the Noobly Cloud agent on an Ubuntu server and enrols it in a site (spec 8.9 R2, task 8.9.10).
# The controller serves this file with its own URL filled in; Add server shows the line that runs it:
#
#   curl -fsSL <controller>/agent/install.sh | sudo bash -s -- --token enr_… [--install-docker] [--install-node]
#
# What it does, and nothing else:
#   - checks Ubuntu 22.04 or 24.04, Node.js 22 or newer, Docker Engine and git; installs Docker (docker.io), Node.js 22
#     (NodeSource) or git only when asked with --install-docker / --install-node (git is installed when missing);
#   - creates the system user `noobly` in the `docker` group (Docker access is root on this server: see the spec's risks);
#   - downloads the agent's files from the controller into /opt/noobly-agent;
#   - writes the one-time token to /etc/noobly-agent/token (0600, owned by noobly); the agent deletes it once enrolled
#     and keeps its own credential in /var/lib/noobly-agent/agent.json (0600);
#   - with systemd: installs and starts noobly-agent.service; without it (containers, Codespaces): prints the command.
set -euo pipefail

CONTROLLER="__CONTROLLER__"
TOKEN=""
INSTALL_DOCKER=0
INSTALL_NODE=0
DEV=0
PREFIX=/opt/noobly-agent
STATE=/var/lib/noobly-agent
CONF=/etc/noobly-agent
FILES="package.json protocol.js core.js connect.js docker.js ingress.js relay.js bin/noobly-agent.js runtimes/bases.json runtimes/node22.Dockerfile runtimes/python312.Dockerfile runtimes/go123.Dockerfile"

say() { printf 'noobly-agent install: %s\n' "$*"; }
fail() { printf 'noobly-agent install: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --controller) CONTROLLER="${2:-}"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --dev) DEV=1; shift ;;
    *) fail "unknown option $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run it as root (sudo bash -s -- …)."
[[ "$TOKEN" =~ ^enr_[A-Za-z0-9_-]{32,64}$ ]] || fail "--token enr_… is needed: Add server on the Platform page makes one (valid for an hour)."
[[ "$CONTROLLER" =~ ^https?://[A-Za-z0-9.:\[\]-]+(/[A-Za-z0-9._/-]*)?$ ]] || fail "the controller URL is not valid: $CONTROLLER"

# Ubuntu 22.04 or 24.04.
. /etc/os-release 2>/dev/null || fail "no /etc/os-release: this script is for Ubuntu."
[ "${ID:-}" = "ubuntu" ] || fail "this script is for Ubuntu, not ${ID:-unknown}."
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) say "Ubuntu ${VERSION_ID:-?} is not tested; carrying on." ;; esac

export DEBIAN_FRONTEND=noninteractive
APT_UPDATED=0
apt_install() {
  if [ "$APT_UPDATED" -eq 0 ]; then apt-get update -qq; APT_UPDATED=1; fi
  apt-get install -y -qq "$@" >/dev/null
}

command -v curl >/dev/null || apt_install curl ca-certificates
command -v git >/dev/null || { say "installing git"; apt_install git; }

# Docker Engine.
if ! command -v docker >/dev/null; then
  [ "$INSTALL_DOCKER" -eq 1 ] || fail "Docker Engine is not installed. Install it (https://docs.docker.com/engine/install/ubuntu/) or run again with --install-docker."
  say "installing Docker (docker.io)"
  apt_install docker.io
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but not answering (is the daemon running?)."

# Node.js 22 or newer.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt 22 ]; then
  [ "$INSTALL_NODE" -eq 1 ] || fail "Node.js 22 or newer is needed (found $(node -v 2>/dev/null || echo none)). Install it or run again with --install-node."
  say "installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt_install nodejs
fi
NODE="$(command -v node)"

# The agent's user: in the docker group, no login, no home of its own.
if ! id noobly >/dev/null 2>&1; then
  say "creating the system user noobly"
  useradd --system --no-create-home --home-dir "$STATE" --shell /usr/sbin/nologin noobly
fi
getent group docker >/dev/null || groupadd docker
usermod -aG docker noobly

# The agent's files, from the controller (a fixed list; nothing is run while downloading).
say "downloading the agent from $CONTROLLER"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/runtimes"
for f in $FILES; do
  curl -fsSL "$CONTROLLER/agent/files/$f" -o "$TMP/$f" || fail "could not download $f from $CONTROLLER."
done
rm -rf "$PREFIX.new"
mkdir -p "$PREFIX.new"
cp -r "$TMP/." "$PREFIX.new/"
chmod 755 "$PREFIX.new/bin/noobly-agent.js"
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"
chown -R root:root "$PREFIX"

# State and the one-time token.
install -d -m 0700 -o noobly -g noobly "$STATE"
install -d -m 0700 -o noobly -g noobly "$CONF"
umask 077
printf '%s\n' "$TOKEN" > "$CONF/token"
chown noobly:noobly "$CONF/token"
chmod 0600 "$CONF/token"
if [ -f "$STATE/agent.json" ]; then
  say "this server was enrolled before; moving its old credential aside to enrol again"
  mv "$STATE/agent.json" "$STATE/agent.json.old"
fi

DEV_FLAG=""
[ "$DEV" -eq 1 ] && DEV_FLAG=" --dev"
RUN="$NODE $PREFIX/bin/noobly-agent.js run --controller $CONTROLLER --token-file $CONF/token --state-dir $STATE$DEV_FLAG"

if [ -d /run/systemd/system ]; then
  say "installing noobly-agent.service"
  cat > /etc/systemd/system/noobly-agent.service <<UNIT
[Unit]
Description=Noobly Cloud agent (local servers)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=noobly
Group=noobly
SupplementaryGroups=docker
ExecStart=$RUN
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=false
ReadWritePaths=$STATE $CONF

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now noobly-agent.service
  say "started. Follow it with: journalctl -u noobly-agent -f"
else
  say "this machine has no systemd (a container?). Start the agent yourself, and keep it running:"
  printf '\n  sudo -u noobly -g docker %s\n\n' "$RUN"
fi
say "done. The server appears on the Platform page under its site once the agent connects."
