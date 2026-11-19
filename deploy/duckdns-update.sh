#!/usr/bin/env bash
# DuckDNS AAAA update for the IPv6-only VPS. Token lives in /etc/hearth/duckdns.env (0600 root).
# NOTE: www.duckdns.org is IPv4-only. If this VPS has no NAT64/DNS64, the update cannot run
# here - set the AAAA record manually in the DuckDNS web UI from a dual-stack machine
# (the VPS IPv6 is stable), or enable NAT64. This script detects that and fails clearly.
set -euo pipefail
umask 077
. /etc/hearth/duckdns.env   # DUCKDNS_DOMAIN=your-domain  DUCKDNS_TOKEN=xxx
V6="$(curl -6 -fsS --max-time 15 https://api64.ipify.org)"
[ -n "$V6" ] || { echo "ERROR: could not determine global IPv6"; exit 1; }
if ! getent hosts www.duckdns.org >/dev/null 2>&1; then
  echo "ERROR: www.duckdns.org not reachable (IPv4-only endpoint, no NAT64)."
  echo "Set AAAA=$V6 manually in the DuckDNS web UI, or enable NAT64 on the VPS."
  exit 1
fi
resp="$(curl -fsS --max-time 20 "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ipv6=${V6}")"
[ "$resp" = "OK" ] || { echo "DuckDNS failed: $resp"; exit 1; }
echo "DuckDNS AAAA updated: $V6"
# IPv4 variant (only if native IPv4/NAT64 exists): add &ip=<ipv4> instead of &ipv6=.
