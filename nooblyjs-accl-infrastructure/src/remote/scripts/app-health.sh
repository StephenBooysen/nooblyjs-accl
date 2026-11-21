#!/usr/bin/env bash
# Waits for a new container to answer its health check with 200 (architecture.md §9): GET http://127.0.0.1:<port><path>
# until 200 or the time runs out. With no port, the container only has to keep running for 10 seconds (a worker).
# Prints {"ok":true,"status":200,"seconds":n} or {"ok":false,"status":<last>,"message":"…"}.
# Args: <container> <host port, or -> <path, or -> <timeout in seconds>
set -uo pipefail
name="${1:-}"; port="${2:--}"; path="${3:--}"; limit="${4:-60}"
fail() { printf '{"ok":false,"status":%s,"message":"%s"}\n' "${2:-null}" "$1"; exit 4; }
[[ "$name" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || { echo '{"ok":false,"message":"Not a container name."}'; exit 2; }
[[ "$limit" =~ ^[0-9]{1,4}$ ]] || { echo '{"ok":false,"message":"Not a timeout."}'; exit 2; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]; }
start=$(date +%s)
last=null
if [ "$port" = "-" ]; then
  sleep 10
  running || fail "The container stopped: $(docker logs --tail 1 "$name" 2>&1 | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-200)"
  printf '{"ok":true,"status":null,"seconds":%s}\n' "$(( $(date +%s) - start ))"; exit 0
fi
[[ "$port" =~ ^[0-9]{1,5}$ ]] || { echo '{"ok":false,"message":"Not a port."}'; exit 2; }
[[ "$path" =~ ^/[A-Za-z0-9._~/?=\&%-]*$ ]] || { echo '{"ok":false,"message":"Not a path."}'; exit 2; }
while [ $(( $(date +%s) - start )) -lt "$limit" ]; do
  running || fail "The container stopped: $(docker logs --tail 1 "$name" 2>&1 | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-200)" "$last"
  last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port$path" || true)
  [ "$last" = "200" ] && { printf '{"ok":true,"status":200,"seconds":%s}\n' "$(( $(date +%s) - start ))"; exit 0; }
  [ "$last" = "000" ] && last=null
  sleep 2
done
fail "GET $path did not answer 200 within $limit seconds" "$last"
