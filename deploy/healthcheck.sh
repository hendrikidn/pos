#!/usr/bin/env bash
# Pemeriksaan kesehatan server untuk cron (tiap 5 menit). Hanya memperingatkan lewat ALERT_WEBHOOK_URL saat keadaan BERUBAH (masalah baru atau pulih)
# dan mengingatkan tiap 6 jam selama masalah berlanjut, supaya tidak membanjiri.
#
#   */5 * * * * $HOME/pos/deploy/healthcheck.sh >> $HOME/backups/healthcheck.log 2>&1
#
# Yang diperiksa: API siap (/readyz), semua container berjalan, disk (peringatan 80%, kritis 90%) untuk / dan folder cadangan, umur cadangan
# terakhir (maks 26 jam), umur uji pulih terakhir (maks 8 hari), dan ukuran database (informasi).
# Pengaturan: BACKUP_DIR, API_PORT, ALERT_WEBHOOK_URL (lingkungan atau deploy/.env); PG_MODE=direct untuk uji tanpa Docker; HC_URL mengganti alamat /readyz.
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

DIR="$(cfg BACKUP_DIR)"; DIR="${DIR:-$HOME/backups}"
API_PORT="$(cfg API_PORT)"; API_PORT="${API_PORT:-18081}"
URL="${HC_URL:-http://127.0.0.1:$API_PORT/readyz}"
NOW="$(date +%s)"
PROBLEMS=()

# 1. API siap (tiga percobaan: restart singkat saat deploy tidak dianggap masalah)
ok=0
for i in 1 2 3; do
  if curl -fsS -m 5 "$URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || PROBLEMS+=("API tidak siap: $URL tidak menjawab 200")

# 2. Container
if [ "$PG_MODE" = docker ] && command -v docker >/dev/null 2>&1; then
  down="$(docker compose ps --services --status running 2>/dev/null | sort | tr '\n' ' ')"
  for svc in db api dashboard admin; do
    case " $down" in *" $svc "*) ;; *) PROBLEMS+=("container $svc tidak berjalan") ;; esac
  done
fi

# 3. Disk
for path in / "$DIR"; do
  [ -d "$path" ] || continue
  use="$(df -P "$path" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [ -n "$use" ] || continue
  if [ "$use" -ge 90 ]; then PROBLEMS+=("disk $path KRITIS: terpakai ${use}%")
  elif [ "$use" -ge 80 ]; then PROBLEMS+=("disk $path hampir penuh: terpakai ${use}%"); fi
done

# 4. Umur cadangan dan uji pulih
age_of() { [ -f "$1" ] && echo $(( NOW - $(cat "$1") )) || echo ""; }
b="$(age_of "$DIR/.last_ok")"
if [ -z "$b" ]; then PROBLEMS+=("belum pernah ada cadangan yang berhasil di $DIR")
elif [ "$b" -gt $((26 * 3600)) ]; then PROBLEMS+=("cadangan terakhir berhasil $((b / 3600)) jam lalu (batas 26 jam)"); fi
r="$(age_of "$DIR/.last_restore_ok")"
if [ -z "$r" ]; then PROBLEMS+=("uji pulih belum pernah lolos (jalankan restore-test.sh)")
elif [ "$r" -gt $((8 * 86400)) ]; then PROBLEMS+=("uji pulih terakhir lolos $((r / 86400)) hari lalu (batas 8 hari)"); fi

# 5. Informasi ukuran database
if [ "$ok" = 1 ] && [ -n "${PG_DB_NAME:-}" ]; then
  size="$(psql_cmd "$PG_DB_NAME" -c "select pg_size_pretty(pg_database_size(current_database()))" 2>/dev/null || true)"
  [ -z "$size" ] || echo "info: ukuran database $size"
fi

STATE="$DIR/.healthcheck.state"
SIG="$(printf '%s\n' "${PROBLEMS[@]:-}" | shasum -a 256 | cut -d' ' -f1)"
PREV_SIG=""; PREV_AT=0
[ -f "$STATE" ] && read -r PREV_SIG PREV_AT < "$STATE"
if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  echo "$(date -u +%FT%TZ) sehat"
  if [ -n "$PREV_SIG" ] && [ "$PREV_SIG" != "OK" ]; then notify "Server $(hostname) kembali sehat."; fi
  echo "OK $NOW" > "$STATE"
  exit 0
fi
printf '%s MASALAH: %s\n' "$(date -u +%FT%TZ)" "$(IFS=';'; echo "${PROBLEMS[*]}")"
if [ "$SIG" != "$PREV_SIG" ] || [ $((NOW - PREV_AT)) -ge $((6 * 3600)) ]; then
  notify "Masalah di $(hostname): $(IFS=';'; echo "${PROBLEMS[*]}")"
  echo "$SIG $NOW" > "$STATE"
fi
exit 1
