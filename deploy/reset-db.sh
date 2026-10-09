#!/usr/bin/env bash
# Hapus SELURUH data database Anatta POS dan mulai dari kosong. Hanya untuk data uji. Jalankan di server sebagai pengguna posguard:
#
#   ~/pos/deploy/reset-db.sh --admin hendrik "Hendrik"   # reset, lalu buat admin platform baru dan cetak tokennya
#   ~/pos/deploy/reset-db.sh                             # reset saja (buat admin sendiri sesudahnya, lihat README)
#   ~/pos/deploy/reset-db.sh --no-backup                 # lewati cadangan (data benar-benar hilang)
#   ~/pos/deploy/reset-db.sh --yes                       # lewati pertanyaan konfirmasi (untuk skrip)
#
# Yang terhapus: semua tenant, outlet, perangkat, pengguna, pesanan, event, insiden, dan admin platform. Sensor yang sudah
# dipasang akan menerima 401 dan harus direset lalu dipairing ulang dengan kode baru.
set -Eeuo pipefail

cd "$(dirname "$0")"
BACKUP=1
ASSUME_YES=0
ADMIN_ID=""
ADMIN_NAME=""
WAIT_SECONDS="${WAIT_SECONDS:-120}"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-backup) BACKUP=0 ;;
    --yes) ASSUME_YES=1 ;;
    --admin)
      [ $# -ge 3 ] || { echo "--admin butuh dua nilai: ID dan NAMA (mis. --admin hendrik \"Hendrik\")" >&2; exit 2; }
      ADMIN_ID="$2"; ADMIN_NAME="$3"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opsi tidak dikenal: $1 (lihat --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mGAGAL: %s\033[0m\n' "$*" >&2; exit 1; }

say "Pemeriksaan awal"
command -v docker >/dev/null 2>&1 || die "docker belum terpasang"
docker info >/dev/null 2>&1 || die "tidak bisa mengakses Docker (pengguna ini harus ada di grup 'docker')"
[ -f .env ] || die "deploy/.env belum ada"
docker compose ps --status running --services 2>/dev/null | grep -x db >/dev/null || die "container database tidak berjalan (docker compose up -d db)"
ok "Docker dan database siap"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n\033[31mSEMUA data database "posguard" akan dihapus.\033[0m\n'
  [ "$BACKUP" -eq 1 ] && echo "Cadangan dibuat dulu." || echo "TANPA cadangan."
  printf 'Ketik HAPUS untuk melanjutkan: '
  read -r answer
  [ "$answer" = "HAPUS" ] || die "dibatalkan"
fi

if [ "$BACKUP" -eq 1 ]; then
  say "Cadangan"
  # Folder yang sama dengan cron di README (bawaan backup.sh, /var/backups, butuh root).
  mkdir -p "${BACKUP_DIR:-$HOME/backups}"
  BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}" ./backup.sh || die "cadangan gagal; tidak ada yang dihapus. Perbaiki atau pakai --no-backup"
fi

say "Menghentikan API"
docker compose stop api
ok "API berhenti"

say "Menghapus dan membuat ulang database"
docker compose exec -T db psql -U posguard -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists posguard with (force)" -c "create database posguard"
docker compose exec -T db psql -U posguard -d posguard -c "create role app_user nologin" 2>/dev/null || true
ok "Database kosong"

say "Menjalankan API (migrasi membuat tabel)"
docker compose up -d api
deadline=$((SECONDS + WAIT_SECONDS))
until docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || die "API belum sehat setelah ${WAIT_SECONDS} detik. Lihat: docker compose logs --tail=50 api"
  sleep 3
done
ok "API berjalan"

if [ -n "$ADMIN_ID" ]; then
  say "Membuat admin platform"
  echo "Simpan token di bawah ini; hanya tampil sekali."
  docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id "$ADMIN_ID" --name "$ADMIN_NAME"
else
  warn "Admin platform belum dibuat. Tanpa admin, halaman admin tidak bisa dimasuki. Jalankan:"
  echo "  docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id ID --name \"Nama\""
fi

say "Selesai"
echo "Langkah berikut: masuk ke halaman admin dengan token, buat tenant baru, lalu buat kode pairing untuk sensor."
