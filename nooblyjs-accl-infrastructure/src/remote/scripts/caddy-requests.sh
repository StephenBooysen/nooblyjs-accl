#!/usr/bin/env bash
# Requests in the last 24 hours per address, from Caddy's JSON access log (roadmap 6.10), as one line of JSON:
# {"hosts":[{"host":"shop.example.com","total":1520,"ok":1498}]} — `ok` counts 1xx, 2xx and 3xx answers. Reads only.
set -uo pipefail
log=/var/log/caddy/access.log
since=$(( $(date +%s) - 86400 ))
if ! sudo test -f "$log"; then echo '{"hosts":[]}'; exit 0; fi
sudo cat "$log" 2>/dev/null \
  | jq -r --argjson since "$since" 'select((.ts // 0) >= $since) | "\(.request.host // "-") \(.status // 0)"' 2>/dev/null \
  | awk '{ host=$1; if (host !~ /^[a-z0-9.:-]+$/) next; t[host]++; if ($2 < 400) ok[host]++ }
         END { printf "{\"hosts\":["; n=0; for (h in t) { if (n++) printf ","; printf "{\"host\":\"%s\",\"total\":%d,\"ok\":%d}", h, t[h], ok[h] } printf "]}\n" }'
