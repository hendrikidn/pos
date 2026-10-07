#!/usr/bin/env bash
# Deploy atau perbarui POS Guard di server dengan satu perintah. Jalankan sebagai pengguna posguard:
#
#   ~/pos/deploy/deploy.sh                 # tarik kode terbaru, cadangkan DB, bangun, jalankan, periksa
#   ~/pos/deploy/deploy.sh --no-pull       # pakai kode yang sudah ada di folder ini (mis. setelah checkout commit lama)
#   ~/pos/deploy/deploy.sh --no-backup     # lewati cadangan sebelum deploy (tidak disarankan)
#
# Aman dijalankan berulang. Migrasi database berjalan otomatis saat API start dan hanya maju (tidak ada pembatalan otomatis).
set -Eeuo pipefail

cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
PULL=1
BACKUP=1
WAIT_SECONDS="${WAIT_SECONDS:-240}"

for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opsi tidak dikenal: $arg (lihat --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mGAGAL: %s\033[0m\n' "$*" >&2; exit 1; }

# Nilai dari .env tanpa meng-source-nya (nilai seperti MAIL_FROM berisi spasi dan tanda < >).
envval() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }

# ---------- 1. Pemeriksaan awal ----------
say "Pemeriksaan awal"
command -v docker >/dev/null 2>&1 || die "docker belum terpasang (lihat deploy/README.md langkah 3)"
docker compose version >/dev/null 2>&1 || die "plugin 'docker compose' tidak ada"
docker info >/dev/null 2>&1 || die "tidak bisa mengakses Docker. Pastikan pengguna ini ada di grup 'docker' (sudo usermod -aG docker \$USER, lalu login ulang)"
[ -f .env ] || die "deploy/.env belum ada. Jalankan: cp .env.example .env, lalu isi DOMAIN dan POSTGRES_PASSWORD"
[ -n "$(envval POSTGRES_PASSWORD)" ] || die "POSTGRES_PASSWORD di deploy/.env masih kosong (buat dengan: openssl rand -hex 24)"
[ -n "$(envval DOMAIN)" ] || die "DOMAIN di deploy/.env masih kosong (mis. pos.dolanyu.com)"
ok "Docker, compose, dan deploy/.env siap"

API_PORT="$(envval API_PORT)"; API_PORT="${API_PORT:-18081}"
DASHBOARD_PORT="$(envval DASHBOARD_PORT)"; DASHBOARD_PORT="${DASHBOARD_PORT:-18082}"
ADMIN_PORT="$(envval ADMIN_PORT)"; ADMIN_PORT="${ADMIN_PORT:-18083}"
DOMAIN="$(envval DOMAIN)"
BEFORE="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '-')"

# ---------- 2. Kode terbaru ----------
if [ "$PULL" = 1 ]; then
  say "Menarik kode terbaru"
  if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
    die "ada perubahan lokal yang belum di-commit di $REPO. Batalkan atau simpan dulu (git status)"
  fi
  git -C "$REPO" pull --ff-only || die "git pull gagal (riwayat lokal menyimpang dari GitHub?). Selesaikan manual di $REPO"
  AFTER="$(git -C "$REPO" rev-parse --short HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then ok "sudah terbaru ($AFTER)"; else ok "$BEFORE → $AFTER"; git -C "$REPO" log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'; fi
else
  say "Melewati git pull (--no-pull)"
fi
NOW="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '-')"

# ---------- 3. Cadangan sebelum perubahan ----------
if [ "$BACKUP" = 1 ]; then
  DB_ID="$(docker compose ps -q db 2>/dev/null || true)"
  if [ -n "$DB_ID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$DB_ID" 2>/dev/null || echo false)" = "true" ]; then
    say "Mencadangkan database"
    export BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
    bash ./backup.sh || die "cadangan gagal, deploy dibatalkan sebelum mengubah apa pun. Perbaiki penyebabnya, atau jalankan dengan --no-backup bila Anda yakin"
  else
    say "Cadangan dilewati (database belum berjalan; ini deploy pertama)"
  fi
else
  say "Cadangan dilewati (--no-backup)"
fi

# ---------- 4. Bangun dan jalankan ----------
say "Membangun dan menjalankan layanan (bisa 5–10 menit pada build pertama)"
docker compose up -d --build --remove-orphans || die "docker compose gagal. Lihat pesan di atas"

# ---------- 5. Tunggu semua layanan sehat ----------
say "Menunggu layanan sehat (maks. ${WAIT_SECONDS} dtk)"
SERVICES=(db api dashboard admin)
state() { # status kesehatan satu layanan: healthy | starting | unhealthy | exited | missing
  local id; id="$(docker compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$id" ] || { echo missing; return; }
  local run; run="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)"
  [ "$run" = "running" ] || { echo "$run"; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$id" 2>/dev/null || echo unknown
}
fail_report() {
  warn "Layanan bermasalah: $1 ($2)"
  echo; docker compose logs --tail=40 "$1" 2>&1 | sed 's/^/      /'
  echo
  echo "Pemulihan:"
  echo "  • Kode sebelumnya: cd $REPO && git checkout $BEFORE && ./deploy/deploy.sh --no-pull --no-backup"
  echo "  • Migrasi database hanya maju. Bila perlu data lama, pulihkan dari cadangan di ${BACKUP_DIR:-$HOME/backups} (deploy/README.md bagian 9)."
  die "deploy tidak sehat"
}
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  all=1
  for s in "${SERVICES[@]}"; do
    st="$(state "$s")"
    case "$st" in
      healthy) ;;
      starting|created|restarting|running) all=0 ;;
      *) fail_report "$s" "$st" ;;
    esac
  done
  [ "$all" = 1 ] && break
  [ "$(date +%s)" -lt "$deadline" ] || { for s in "${SERVICES[@]}"; do [ "$(state "$s")" = healthy ] || fail_report "$s" "belum sehat setelah ${WAIT_SECONDS} dtk"; done; }
  sleep 3
done
for s in "${SERVICES[@]}"; do ok "$s sehat"; done

# ---------- 6. Uji asap ----------
say "Uji asap"
http() { curl -fsS --max-time 8 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
[ "$(curl -fsS --max-time 8 "http://127.0.0.1:$API_PORT/healthz" 2>/dev/null | grep -c '"ok":true' || true)" = 1 ] && ok "API  http://127.0.0.1:$API_PORT/healthz" || die "API tidak menjawab /healthz di port $API_PORT"
[ "$(http "http://127.0.0.1:$DASHBOARD_PORT/login")" = 200 ] && ok "Dashboard owner  :$DASHBOARD_PORT" || die "dashboard tidak menjawab di port $DASHBOARD_PORT"
[ "$(http "http://127.0.0.1:$ADMIN_PORT/login")" = 200 ] && ok "Konsol admin  :$ADMIN_PORT" || die "konsol admin tidak menjawab di port $ADMIN_PORT"
if curl -fsS --max-time 10 "https://$DOMAIN/healthz" 2>/dev/null | grep -q '"ok":true'; then
  ok "Publik  https://$DOMAIN/healthz"
else
  warn "https://$DOMAIN/healthz belum terjangkau dari server ini (DNS, nginx, atau sertifikat belum siap? lihat deploy/README.md langkah 6)"
fi

# ---------- 7. Peringatan konfigurasi ----------
say "Catatan"
if [ -z "$(envval SMTP_HOST)" ] || [ -z "$(envval SMTP_PASS)" ]; then
  warn "SMTP belum diisi di deploy/.env: kode masuk email tidak terkirim, owner hanya bisa masuk dengan token (langkah 6b)"
else
  ok "SMTP dikonfigurasi ($(envval SMTP_HOST))"
fi
ADMINS="$(docker compose exec -T db psql -U posguard -d posguard -tAc 'select count(*) from platform_admin' 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$ADMINS" = "0" ]; then
  warn "Belum ada admin platform. Buat sekali:"
  echo "      cd $REPO/deploy && docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id admin --name \"Admin\""
fi
docker image prune -f >/dev/null 2>&1 || true

say "Selesai: commit $NOW sudah berjalan"
echo "  Dashboard owner : https://$DOMAIN"
echo "  Konsol admin    : https://<domain-admin> (nginx → 127.0.0.1:$ADMIN_PORT)"
echo "  Log             : cd $REPO/deploy && docker compose logs -f api"
