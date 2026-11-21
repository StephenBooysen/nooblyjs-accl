#!/usr/bin/env bash
# Puts an uploaded certificate and its key in place for one endpoint (sent over SFTP to ~/.noobly/), readable by Caddy
# only. The key never passes through a command line. Prints one JSON line.
# Args: <endpoint id> <staged certificate> <staged key>
set -uo pipefail
id="${1:-}"
if [[ ! "$id" =~ ^[a-z]{2,8}_[a-z0-9]{4,32}$ ]]; then echo '{"ok":false,"message":"Not an endpoint id."}'; exit 2; fi
for f in "${2:-}" "${3:-}"; do
  if [[ ! "$f" =~ ^[a-z0-9][a-z0-9._-]{0,200}$ ]] || [ ! -f "$HOME/.noobly/$f" ]; then echo '{"ok":false,"message":"The certificate did not arrive."}'; exit 2; fi
done
sudo install -m 0644 -o root -g caddy "$HOME/.noobly/$2" "/etc/caddy/certs/${id}.crt"
sudo install -m 0640 -o root -g caddy "$HOME/.noobly/$3" "/etc/caddy/certs/${id}.key"
rm -f "$HOME/.noobly/$2" "$HOME/.noobly/$3"
echo '{"ok":true}'
