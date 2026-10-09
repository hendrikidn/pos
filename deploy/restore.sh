#!/usr/bin/env bash
# Memulihkan database PRODUKSI dari cadangan. MENGGANTI seluruh data yang ada. Jalankan sebagai pengguna posguard, hanya saat darurat:
#
#   ./restore.sh /path/posguard-TANGGAL.dump[.enc]
#
# Urutan: konfirmasi (ketik PULIHKAN), cadangan keadaan sekarang, hentikan api/dashboard/admin, buat ulang database, pulihkan,
# periksa keutuhan (verify.sql), jalankan lagi. Bila pemulihan gagal, database lama ada di cadangan "sebelum-pulih" yang baru dibuat.
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "pakai: ./restore.sh BERKAS_CADANGAN" >&2; exit 2; }
[ "$PG_MODE" = docker ] || { echo "restore.sh hanya untuk mode docker (produksi). Untuk uji, pakai restore-test.sh" >&2; exit 2; }

echo "Ini MENGGANTI seluruh database produksi dengan isi $(basename "$FILE")."
read -r -p "Ketik PULIHKAN untuk melanjutkan: " ans
[ "$ans" = "PULIHKAN" ] || { echo "dibatalkan"; exit 1; }

DIR="$(cfg BACKUP_DIR)"; DIR="${DIR:-$HOME/backups}"
echo "==> cadangan keadaan sekarang"
BACKUP_DIR="$DIR/sebelum-pulih" ./backup.sh
echo "==> menghentikan layanan"
docker compose stop api dashboard admin
echo "==> membuat ulang database"
docker compose exec -T db psql -U "$PG_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "drop database $PG_DB_NAME with (force)" -c "create database $PG_DB_NAME owner $PG_DB_USER"
echo "==> memulihkan"
dump_stream "$FILE" | pg_restore_cmd "$PG_DB_NAME"
EXPECTED="$(ls -1 ../apps/api/src/db/migrations/*.sql | wc -l | tr -d ' ')"
RESULT="$(psql_cmd "$PG_DB_NAME" -v "expected_migrations=$EXPECTED" -f - < verify.sql | tr '|' ' ')"
printf '%s\n' "$RESULT"
if printf '%s\n' "$RESULT" | grep -q 'GAGAL$'; then echo "PERIKSA: ada pemeriksaan yang tidak lolos. Layanan TIDAK dinyalakan." >&2; exit 1; fi
echo "==> menyalakan layanan"
docker compose up -d api dashboard admin
notify "Database dipulihkan dari $(basename "$FILE") di $(hostname)."
echo "selesai. Cek: curl http://127.0.0.1:$(cfg API_PORT)/readyz"
