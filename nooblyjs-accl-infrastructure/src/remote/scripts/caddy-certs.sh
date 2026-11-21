#!/usr/bin/env bash
# The certificates Caddy holds (roadmap 3.5: status and expiry from Caddy), as one line of JSON:
# {"certs":[{"host":"shop.example.com","issuer":"acme","expiresAt":"2027-02-14T10:00:00Z"}]}. "local" is Caddy's own
# CA (tls internal, self-signed); anything else came from a public CA. Reads only.
set -uo pipefail
dir=/var/lib/caddy/.local/share/caddy/certificates
printf '{"certs":['
first=1
while IFS= read -r crt; do
  [ -n "$crt" ] || continue
  host=$(basename "$crt" .crt)
  [[ "$host" =~ ^[a-z0-9.*-]{1,253}$ ]] || continue
  issuer_dir=$(basename "$(dirname "$(dirname "$crt")")")
  case "$issuer_dir" in local) issuer=local ;; *) issuer=acme ;; esac
  end=$(sudo openssl x509 -in "$crt" -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] || continue
  iso=$(date -u -d "$end" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || continue
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"host":"%s","issuer":"%s","expiresAt":"%s"}' "$host" "$issuer" "$iso"
done < <(sudo find "$dir" -name '*.crt' -type f 2>/dev/null)
printf ']}\n'
