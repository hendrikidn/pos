#!/usr/bin/env bash
# Cadangan database harian. Jalankan dari cron (lihat deploy/README.md bagian 9).
#
#   BACKUP_DIR=$HOME/backups ./backup.sh
#
# Yang dilakukan: pg_dump -Fc, memeriksa bahwa arsipnya terbaca dan tidak kosong, mencatat checksum, mengenkripsi (bila BACKUP_PASSPHRASE_FILE
# diisi), menyalin ke LUAR server (bila BACKUP_REMOTE diisi), memutar salinan (14 harian, 8 mingguan, 12 bulanan), dan mencatat waktu
# keberhasilan untuk healthcheck.sh. Gagal di langkah mana pun = keluar dengan kode salah + peringatan ke ALERT_WEBHOOK_URL.
#
# Pengaturan (lingkungan atau deploy/.env):
#   BACKUP_DIR              folder cadangan lokal (bawaan $HOME/backups)
#   BACKUP_PASSPHRASE_FILE  berkas berisi kata sandi enkripsi; kosong = tidak dienkripsi (WAJIB diisi bila disalin ke penyimpanan pihak ketiga)
#   BACKUP_REMOTE           tujuan salinan luar server: "rclone:NAMA_REMOTE:folder" atau "rsync:user@host:/folder"
#   PG_MODE=direct PG_URL=postgres://...   akses langsung tanpa Docker (lihat lib.sh)
set -Eeuo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

DIR="$(cfg BACKUP_DIR)"; DIR="${DIR:-$HOME/backups}"
PASS="$(cfg BACKUP_PASSPHRASE_FILE)"
REMOTE="$(cfg BACKUP_REMOTE)"
mkdir -p "$DIR/weekly" "$DIR/monthly"

STAMP="$(date +%F-%H%M)"
BASE="$DIR/posguard-$STAMP.dump"
TMP="$BASE.tmp"
trap 'rc=$?; rm -f "$TMP" "$TMP.enc"; if [ $rc -ne 0 ]; then notify "CADANGAN GAGAL di $(hostname) (kode $rc). Periksa $DIR/backup.log."; echo "cadangan GAGAL (kode $rc)" >&2; fi' EXIT

pg_dump_cmd > "$TMP"
[ -s "$TMP" ] || { echo "dump kosong" >&2; exit 1; }
# Arsip harus terbaca dan memuat tabel utama; dump yang terpotong atau rusak ketahuan di sini, bukan saat dibutuhkan.
LIST="$(pg_list_cmd < "$TMP")"
# Catatan: grep TANPA -q (keluaran dibuang). Dengan -q grep keluar begitu menemukan kecocokan, printf yang masih menulis kena SIGPIPE, dan karena
# `pipefail` seluruh pipa dianggap gagal: pemeriksaan acak gagal padahal arsipnya utuh (terjadi di VPS dengan CPU sedikit).
for t in event tenant outlet schema_migration; do
  printf '%s\n' "$LIST" | grep -E "TABLE DATA public $t " >/dev/null || { echo "arsip tidak memuat data tabel $t" >&2; exit 1; }
done

OUT="$BASE"
if [ -n "$PASS" ]; then
  [ -r "$PASS" ] || { echo "BACKUP_PASSPHRASE_FILE tidak terbaca: $PASS" >&2; exit 1; }
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS" -in "$TMP" -out "$TMP.enc"
  mv "$TMP.enc" "$BASE.enc"; rm -f "$TMP"; OUT="$BASE.enc"
else
  mv "$TMP" "$BASE"
fi
chmod 600 "$OUT"
( cd "$DIR" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

# Salinan luar server. Gagal di sini membuat seluruh cadangan dianggap gagal: cadangan yang hanya ada di server yang sama bukan cadangan.
if [ -n "$REMOTE" ]; then
  case "$REMOTE" in
    rclone:*) rclone copy "$OUT" "$OUT.sha256" "${REMOTE#rclone:}" ;;
    rsync:*)  rsync -a "$OUT" "$OUT.sha256" "${REMOTE#rsync:}/" ;;
    *) echo "BACKUP_REMOTE tidak dikenal (pakai rclone:... atau rsync:...)" >&2; exit 1 ;;
  esac
  echo "disalin ke luar server: $REMOTE"
fi

# Rotasi: yang hari Minggu juga disalin ke weekly/ (8 minggu), tanggal 1 ke monthly/ (12 bulan); harian 14 hari.
[ "$(date +%u)" = 7 ] && cp -p "$OUT" "$OUT.sha256" "$DIR/weekly/"
[ "$(date +%d)" = 01 ] && cp -p "$OUT" "$OUT.sha256" "$DIR/monthly/"
find "$DIR" -maxdepth 1 -name 'posguard-*' -mtime +14 -delete
find "$DIR/weekly" -name 'posguard-*' -mtime +56 -delete
find "$DIR/monthly" -name 'posguard-*' -mtime +366 -delete
date +%s > "$DIR/.last_ok"
echo "cadangan: $OUT ($(du -h "$OUT" | cut -f1)) diperiksa${PASS:+, terenkripsi}${REMOTE:+, disalin keluar}"
