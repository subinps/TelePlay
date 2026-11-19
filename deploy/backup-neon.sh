#!/usr/bin/env bash
# Neon backup. pg_dump needs the DIRECT (non-pooler) endpoint and a client >= server major.
# The Neon endpoint must be reachable from this VPS (IPv6-only: verify at T15 preflight).
set -euo pipefail
umask 077
OUT="${1:-/var/backups/hearth}"
TS="$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$OUT"
if [ -z "${DATABASE_URL:-}" ]; then
  [ -f /etc/hearth/hearth.env ] || { echo "ERROR: DATABASE_URL unset, no env file"; exit 1; }
  set -a; . /etc/hearth/hearth.env; set +a
fi
PG_URL="${DATABASE_URL/postgresql+asyncpg:/postgresql:}"
PG_URL="${PG_URL/-pooler./.}"     # pg_dump must use the DIRECT host, not the pooler
PG_URL="${PG_URL%%\?*}"
export PGSSLMODE=require
FILE="$OUT/hearth_${TS}.sql.gz"
echo "Dumping Neon -> $FILE"
pg_dump "$PG_URL" --format=plain --no-owner --no-privileges | gzip > "$FILE"
gzip -t "$FILE"
gunzip -c "$FILE" | tail -n 5 | grep -q "PostgreSQL database dump complete" \
  || { echo "ERROR: incomplete dump"; exit 1; }
echo "OK: $FILE ($(du -h "$FILE" | cut -f1))"
echo "Restore: gunzip -c FILE | psql 'DIRECT postgresql:// URL'"
