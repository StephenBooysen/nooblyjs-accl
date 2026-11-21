#!/usr/bin/env bash
# Removes one public address's site file and reloads Caddy (its last endpoint was removed). Prints one JSON line.
# Args: <host>
set -uo pipefail
host="${1:-}"
if [[ ! "$host" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || [[ "$host" == *..* ]]; then echo '{"ok":false,"message":"Not an address."}'; exit 2; fi
sudo rm -f "/etc/caddy/sites/${host}.caddy"
sudo systemctl reload caddy || { echo '{"ok":false,"message":"Caddy did not reload."}'; exit 5; }
echo '{"ok":true}'
