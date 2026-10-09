#!/usr/bin/env bash
# Uji pulih: memulihkan cadangan TERBARU (atau berkas yang disebut) ke database sementara, menjalankan pemeriksaan keutuhan (verify.sql: skema,
# rantai event tanpa lubang atau putus, kebijakan RLS), lalu menghapusnya. Database asli tidak disentuh. Jalankan mingguan dari cron.
#
#   ./restore-test.sh                         # cadangan terbaru di BACKUP_DIR
#   ./restore-test.sh /path/posguard-2026-10-09-0300.dump[.enc]
#
# Keluar 0 hanya bila semua pemeriksaan OK. Gagal = peringatan ke ALERT_WEBHOOK_URL. Hasil sukses dicatat untuk healthcheck.sh.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

DIR="$(cfg BACKUP_DIR)"; DIR="${DIR:-$HOME/backups}"
FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -1t "$DIR"/posguard-*.dump "$DIR"/posguard-*.dump.enc 2>/dev/null | head -1 || true)"
fi
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "tidak ada cadangan di $DIR" >&2; notify "UJI PULIH GAGAL: tidak ada berkas cadangan di $DIR"; exit 1; }

SCRATCH="restore_test_$(date +%s)"
cleanup() {
  rc=$?
  psql_cmd postgres -c "drop database if exists $SCRATCH" >/dev/null 2>&1 || true
  if [ $rc -ne 0 ]; then notify "UJI PULIH GAGAL untuk $(basename "$FILE") di $(hostname)"; fi
  exit $rc
}
trap cleanup EXIT

# Checksum yang dicatat saat cadangan dibuat harus cocok (berkas rusak atau diubah ketahuan).
if [ -f "$FILE.sha256" ]; then
  ( cd "$(dirname "$FILE")" && shasum -a 256 -c "$(basename "$FILE").sha256" >/dev/null ) || { echo "checksum $FILE tidak cocok" >&2; exit 1; }
  echo "checksum cocok"
else
  echo "peringatan: tidak ada berkas .sha256 untuk $(basename "$FILE")" >&2
fi

psql_cmd postgres -c "create database $SCRATCH" >/dev/null
# Role aplikasi dipakai kebijakan dan hak akses; pada klaster yang baru dibuat (mis. uji lokal) belum ada.
psql_cmd postgres -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'app_user') then create role app_user nologin; end if; end \$\$" >/dev/null
START=$(date +%s)
dump_stream "$FILE" | pg_restore_cmd "$SCRATCH"
echo "dipulihkan dalam $(( $(date +%s) - START )) detik"

EXPECTED="$(ls -1 ../apps/api/src/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
[ "${EXPECTED:-0}" -gt 0 ] || { echo "folder migrasi tidak ditemukan (jalankan dari salinan repo)" >&2; exit 1; }
RESULT="$(psql_cmd "$SCRATCH" -v "expected_migrations=$EXPECTED" -f - < verify.sql | tr '|' ' ')"
printf '%s\n' "$RESULT" | awk '{printf "  %-34s %-12s %s\n", $1, $2, $3}'
if printf '%s\n' "$RESULT" | grep 'GAGAL$' >/dev/null; then echo "UJI PULIH GAGAL: ada pemeriksaan yang tidak lolos" >&2; exit 1; fi
date +%s > "$DIR/.last_restore_ok"
echo "uji pulih LOLOS: $(basename "$FILE")"
