#!/usr/bin/env bash
# Puts one public address's site file in place (architecture.md §9, "Endpoints"). The file was sent over SFTP to
# ~/.noobly/<staged>; Caddy checks its whole configuration with it, and only then reloads. A file Caddy refuses is taken
# out again and the one before it put back, so a bad endpoint never takes the other addresses down. Prints one JSON line.
# Args: <host> <staged file name>
set -uo pipefail
host="${1:-}"
staged_name="${2:-}"
if [[ ! "$host" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || [[ "$host" == *..* ]]; then echo '{"ok":false,"message":"Not an address."}'; exit 2; fi
if [[ ! "$staged_name" =~ ^[a-z0-9][a-z0-9._-]{0,200}$ ]]; then echo '{"ok":false,"message":"Not a staged file."}'; exit 2; fi
staged="$HOME/.noobly/$staged_name"
target="/etc/caddy/sites/${host}.caddy"
[ -f "$staged" ] || { echo '{"ok":false,"message":"The site file did not arrive."}'; exit 2; }
backup=""
if sudo test -f "$target"; then backup=$(mktemp); sudo cp "$target" "$backup"; fi
sudo install -m 0644 -o root -g root "$staged" "$target"
rm -f "$staged"
if ! out=$(sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
  if [ -n "$backup" ]; then sudo install -m 0644 -o root -g root "$backup" "$target"; else sudo rm -f "$target"; fi
  rm -f "$backup"
  msg=$(printf '%s' "$out" | tail -n 1 | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-300)
  printf '{"ok":false,"message":"Caddy refused it: %s"}\n' "$msg"
  exit 4
fi
rm -f "$backup"
sudo systemctl reload caddy || { echo '{"ok":false,"message":"Caddy did not reload."}'; exit 5; }
echo '{"ok":true}'
