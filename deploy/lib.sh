# Fungsi bersama skrip operasional (di-source, bukan dijalankan). Dua mode akses PostgreSQL:
#   PG_MODE=docker (bawaan)  : lewat `docker compose exec -T db` (produksi, database di container).
#   PG_MODE=direct           : memakai pg_dump/pg_restore/psql lokal ke PG_URL (uji di mesin tanpa Docker, atau database di host).
# Nilai dibaca dari lingkungan lebih dulu, lalu deploy/.env (tanpa meng-source-nya: nilai seperti MAIL_FROM berisi spasi dan < >).

envval() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
cfg() { local v="${!1:-}"; [ -n "$v" ] || v="$(envval "$1")"; printf '%s' "$v"; }

PG_MODE="${PG_MODE:-docker}"
PG_DB_NAME="${PG_DB_NAME:-posguard}"
PG_DB_USER="${PG_DB_USER:-posguard}"

pg_dump_cmd()    { if [ "$PG_MODE" = direct ]; then pg_dump -Fc --no-owner "$PG_URL"; else docker compose exec -T db pg_dump -U "$PG_DB_USER" -Fc --no-owner "$PG_DB_NAME"; fi; }
# Argumen pertama: nama database tujuan. Archive dibaca dari stdin.
pg_restore_cmd() { if [ "$PG_MODE" = direct ]; then pg_restore --no-owner --exit-on-error -d "$(pg_url_for "$1")"; else docker compose exec -T db pg_restore -U "$PG_DB_USER" -d "$1" --no-owner --exit-on-error; fi; }
pg_list_cmd()    { if [ "$PG_MODE" = direct ]; then pg_restore --list; else docker compose exec -T db pg_restore --list; fi; }
# SQL dari stdin ke database $1 (tanpa header, hasil dipisah |).
psql_cmd()       { if [ "$PG_MODE" = direct ]; then psql -X -q -At -v ON_ERROR_STOP=1 "$(pg_url_for "$1")" "${@:2}"; else docker compose exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U "$PG_DB_USER" -d "$1" "${@:2}"; fi; }
# URL koneksi ke database lain di server yang sama (mode direct): ganti nama database di PG_URL.
pg_url_for()     { printf '%s' "$PG_URL" | sed -E "s#/[^/?]+(\?|\$)#/$1\1#"; }

# Peringatan ke webhook (ALERT_WEBHOOK_URL) bila diisi. Tidak pernah menggagalkan skrip.
notify() {
  local url; url="$(cfg ALERT_WEBHOOK_URL)"
  [ -n "$url" ] || return 0
  local text="[Anatta POS] $1"
  text="${text//\\/\\\\}"; text="${text//\"/\\\"}"
  curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "{\"text\":\"$text\",\"content\":\"$text\"}" "$url" >/dev/null 2>&1 || echo "peringatan gagal dikirim ke webhook" >&2
}

# Berkas dump dibaca sebagai aliran: dekripsi bila berakhiran .enc (openssl, kunci di BACKUP_PASSPHRASE_FILE).
dump_stream() {
  case "$1" in
    *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$(cfg BACKUP_PASSPHRASE_FILE)" -in "$1" ;;
    *) cat "$1" ;;
  esac
}
