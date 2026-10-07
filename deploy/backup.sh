#!/usr/bin/env bash
# Cadangan database harian. Jalankan dari cron (lihat deploy/README.md). Menyimpan 14 hari terakhir.
set -euo pipefail
cd "$(dirname "$0")"
DIR="${BACKUP_DIR:-/var/backups/posguard}"
mkdir -p "$DIR"
OUT="$DIR/posguard-$(date +%F-%H%M).dump"
docker compose exec -T db pg_dump -U posguard -Fc posguard > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
find "$DIR" -name 'posguard-*.dump' -mtime +14 -delete
echo "cadangan: $OUT ($(du -h "$OUT" | cut -f1))"
