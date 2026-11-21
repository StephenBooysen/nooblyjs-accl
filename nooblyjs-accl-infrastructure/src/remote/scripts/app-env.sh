#!/usr/bin/env bash
# Puts an app's environment file in place: /srv/apps/<app>/.env, mode 0600 (architecture.md §9). The values were sent
# over SFTP to ~/.noobly/<staged>; they never pass through a command line.
# Args: <app> <staged file name>
set -uo pipefail
app="${1:-}"; staged_name="${2:-}"
fail() { printf '{"ok":false,"message":"%s"}\n' "$1"; exit "${2:-2}"; }
[[ "$app" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail 'Not an app name.'
[[ "$staged_name" =~ ^[a-z0-9][a-z0-9._-]{0,200}$ ]] || fail 'Not a staged file.'
staged="$HOME/.noobly/$staged_name"
[ -f "$staged" ] || fail 'The environment did not arrive.'
sudo install -d -m 0750 -o noobly -g noobly "/srv/apps/$app"
install -m 0600 "$staged" "/srv/apps/$app/.env" && rm -f "$staged" || fail 'The environment could not be written.' 3
echo '{"ok":true}'
