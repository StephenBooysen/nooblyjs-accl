#!/usr/bin/env bash
# Starts a new container of an app beside the one serving (blue/green, architecture.md §9). It listens on a free
# port of 127.0.0.1 only: Caddy is the way in. A container port of - publishes nothing (a worker).
# Prints {"ok":true,"container":"<name>","port":<host port or null>}.
# Args: <app> <image tag> <container name> <container port, or -> <restart: always | on-failure | no>
set -uo pipefail
app="${1:-}"; tag="${2:-}"; name="${3:-}"; cport="${4:--}"; restart="${5:-always}"
fail() { printf '{"ok":false,"message":"%s"}\n' "$1"; exit "${2:-2}"; }
[[ "$app" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail 'Not an app name.'
[[ "$tag" =~ ^noobly-app/[a-z0-9-]+:[a-z0-9_]{4,40}$ ]] || fail 'Not an image tag.'
[[ "$name" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || fail 'Not a container name.'
[[ "$restart" =~ ^(always|on-failure|no)$ ]] || fail 'Not a restart policy.'
publish=()
port=null
if [ "$cport" != "-" ]; then
  [[ "$cport" =~ ^[0-9]{1,5}$ ]] && [ "$cport" -ge 1 ] && [ "$cport" -le 65535 ] || fail 'Not a port.'
  for p in $(shuf -i 30000-39999 -n 100); do
    if ! ss -Hltn "sport = :$p" | grep -q .; then port=$p; break; fi
  done
  [ "$port" != null ] || fail 'No free port between 30000 and 39999.' 3
  publish=(-p "127.0.0.1:$port:$cport")
fi
env_file="/srv/apps/$app/.env"
[ -f "$env_file" ] || fail 'The environment file is missing.'
docker rm -f "$name" >/dev/null 2>&1
if ! out=$(docker run -d --name "$name" --label "noobly-app=$app" --restart "$restart" --env-file "$env_file" "${publish[@]}" "$tag" 2>&1); then
  msg=$(printf '%s' "$out" | tail -n 1 | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-300)
  fail "The container did not start: $msg" 4
fi
printf '{"ok":true,"container":"%s","port":%s}\n' "$name" "$port"
