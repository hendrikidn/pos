# Deploy POS Guard di VPS (Ubuntu 24.04)

PostgreSQL, API, dan dashboard berjalan di satu VPS dengan Docker Compose. Caddy menjadi pintu masuk dan mengurus sertifikat HTTPS otomatis.

```
Sensor / terminal POS ──HTTPS──► Caddy :443 ──► /v1/*, /healthz ──► API :3000 ──► PostgreSQL (internal)
Browser owner ─────────HTTPS──►        └────── lainnya ───────────► Dashboard :3001
```

Domain: `pos.dolanyu.com`. Hanya port 22, 80, dan 443 yang terbuka. Database tidak punya port yang dipublikasikan.

> **Status:** konfigurasi ini **belum dijalankan di VPS sungguhan** dan Docker tidak tersedia di mesin pengembangan. Yang sudah diuji: instalasi dependensi yang difilter, API start dari hasil instalasi itu (migrasi otomatis, `/healthz`), build dan start dashboard produksi, serta alur API terhadap PostgreSQL 18 asli. **Belum terbukti:** build image, Compose, sertifikat Caddy, `backup.sh`, dan prosedur pemulihan. Bila ada langkah yang gagal, salin pesan errornya.

## Prasyarat

- VPS Contabo dengan Ubuntu 24.04, akses SSH, dan minimal 2 GB RAM (build dashboard memakai memori cukup besar; bila build gagal karena memori, tambahkan swap).
- Subdomain `pos.dolanyu.com` yang bisa Anda atur DNS-nya.
- Kode project sudah ada di repositori GitHub yang bisa diakses dari VPS.

## 1. Arahkan DNS

Di pengelola DNS `dolanyu.com`, buat record:

| Jenis | Nama | Nilai |
|---|---|---|
| A | `pos` | IP publik VPS |
| AAAA | `pos` | IPv6 VPS (opsional; hanya bila VPS benar-benar menjangkau lewat IPv6) |

Tunggu beberapa menit, lalu dari komputer Anda:
```
dig +short pos.dolanyu.com
```
Hasilnya harus IP VPS. **Jangan lanjut sebelum benar**: Caddy butuh DNS yang tepat untuk mendapat sertifikat.

## 2. Siapkan server

Masuk lewat SSH (`ssh root@IP-VPS`), lalu buat pengguna biasa dan amankan akses:

```
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy      # salin kunci SSH bila login dengan kunci
```
Buka sesi baru sebagai `deploy` (`ssh deploy@IP-VPS`) dan pastikan bisa login, baru lanjut. Setelah itu sebaiknya nonaktifkan login root dengan sandi.

Firewall:
```
sudo apt update && sudo apt upgrade -y
sudo apt install -y ufw git curl ca-certificates
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```
Bila di panel Contabo ada fitur firewall, izinkan juga port yang sama di sana.

## 3. Install Docker

Cara resmi untuk Ubuntu:
```
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```
Keluar dan masuk SSH lagi (agar grup `docker` berlaku), lalu uji: `docker run --rm hello-world`.

## 4. Ambil kode dan isi pengaturan

```
git clone https://github.com/hendrikidn/pos.git
cd pos/deploy
cp .env.example .env
nano .env
```
Isi di `.env`:
- `DOMAIN=pos.dolanyu.com`
- `POSTGRES_PASSWORD=` isi dengan hasil `openssl rand -hex 24`
- Opsional: `CORS_ORIGINS` dan `WHATSAPP_*`.

Simpan sandi database itu di pengelola sandi Anda. Repositori privat: gunakan deploy key atau token GitHub saat `git clone`.

## 5. Jalankan

Dari folder `pos/deploy`:
```
docker compose up -d --build
```
Build pertama memakan 5–10 menit. Lalu periksa:
```
docker compose ps                       # semua service "running"/"healthy"
docker compose logs -f caddy            # cari: "certificate obtained successfully"
curl https://pos.dolanyu.com/healthz    # {"ok":true}
```
Migrasi database berjalan otomatis saat API start.

## 6. Buat tenant, outlet, dan token owner (sekali)

```
docker compose run --rm api node_modules/.bin/tsx apps/api/src/setup.ts \
  --tenant usahaku --tenant-name "Usahaku" \
  --outlet senopati --outlet-name "Kopi Senopati" \
  --terminals pos-1,pos-2
```
Token OWNER dicetak **sekali**; simpan di pengelola sandi. Menjalankan perintah lagi aman: tenant dan outlet yang ada dibiarkan dan token OWNER baru terbit (cara memulihkan token yang hilang).

Buka `https://pos.dolanyu.com`, tempel token OWNER, lalu pasang sensor di **Pengaturan → Perangkat**.

## 7. Menghubungkan sensor dan terminal

- Firmware sensor: isi `SERVER_URL` di `secrets.h` dengan `https://pos.dolanyu.com` (butuh firmware dengan dukungan HTTPS), lalu lakukan pairing seperti di panduan sensor.
- Terminal POS: alamat API `https://pos.dolanyu.com`.

## 8. Cadangan database

Cadangan dibuat dengan `pg_dump` oleh [backup.sh](backup.sh) dan disimpan 14 hari.

```
chmod +x ~/pos/deploy/backup.sh
mkdir -p ~/backups
crontab -e
```
Tambahkan baris (jalan tiap hari 03:00):
```
0 3 * * * BACKUP_DIR=$HOME/backups $HOME/pos/deploy/backup.sh >> $HOME/backups/backup.log 2>&1
```
Cadangan di VPS yang sama **tidak cukup**: bila server hilang, cadangannya ikut hilang. Salin juga ke tempat lain secara berkala, misalnya `rsync -a deploy@IP-VPS:backups/ ~/cadangan-posguard/` dari komputer Anda, atau ke penyimpanan objek.

**Pulihkan** ke database kosong (**prosedur ini belum pernah dijalankan**; uji di VPS sebelum Anda membutuhkannya):
```
cd ~/pos/deploy
docker compose stop api dashboard
docker compose exec -T db psql -U posguard -d postgres -c "drop database if exists posguard with (force)" -c "create database posguard"
docker compose exec -T db psql -U posguard -d posguard -c "create role app_user nologin" || true
docker compose exec -T db pg_restore -U posguard -d posguard --no-owner < ~/backups/posguard-TANGGAL.dump
docker compose start api dashboard
```
Role `app_user` harus ada sebelum pemulihan karena hak aksesnya dirujuk oleh dump. **Uji pemulihan sekali sebelum Anda membutuhkannya.**

## 9. Memperbarui versi

```
cd ~/pos
git pull
cd deploy
docker compose up -d --build
```
Migrasi baru diterapkan otomatis. Data di volume `pgdata` tidak tersentuh.

## 10. Perintah sehari-hari

| Perlu | Perintah (dari `~/pos/deploy`) |
|---|---|
| Lihat status | `docker compose ps` |
| Log API | `docker compose logs -f api` |
| Log dashboard / Caddy | `docker compose logs -f dashboard` / `caddy` |
| Restart satu service | `docker compose restart api` |
| Matikan semua (data tetap) | `docker compose down` |
| **Jangan** | `docker compose down -v`: menghapus volume dan seluruh database |

## Keamanan

- Database tidak dipublikasikan ke host; hanya API yang menjangkaunya. Docker melewati aturan `ufw` untuk port yang dipublikasikan, jadi jangan menambahkan `ports:` pada service `db`.
- HTTPS wajib: token perangkat dan token owner tidak boleh lewat HTTP polos di internet.
- API terhubung sebagai pemilik database, lalu `SET ROLE app_user` untuk isolasi per tenant (RLS). Itu sudah dirancang demikian; jangan memberi pengguna aplikasi lain akses ke database.
- Aktifkan pembaruan keamanan otomatis: `sudo apt install unattended-upgrades`.
- Pertimbangkan `fail2ban` untuk SSH dan login SSH hanya dengan kunci.
- Token OWNER setara kunci utama sistem. Simpan di pengelola sandi dan terbitkan ulang bila bocor (jalankan lagi langkah 6).
- Pembatas percobaan kode pairing berjalan per alamat pemanggil (lewat `X-Forwarded-For` dari Caddy) dan disimpan di memori API, jadi reset saat API restart.

## Troubleshooting

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| Caddy gagal mendapat sertifikat | DNS belum mengarah ke VPS, atau port 80/443 diblokir | `dig +short pos.dolanyu.com`; buka port di `ufw` dan panel Contabo; lihat `docker compose logs caddy` |
| Browser "tidak aman" / sertifikat salah | Domain di `.env` beda dengan DNS | Perbaiki `DOMAIN`, `docker compose up -d` |
| `502 Bad Gateway` | API/dashboard belum siap atau crash | `docker compose ps` dan `logs api` |
| API restart terus | Sandi database di `.env` berubah setelah volume dibuat | Kembalikan sandi lama (sandi hanya dipakai saat volume pertama dibuat), atau hapus volume bila datanya belum penting |
| Build gagal/kena kill | Memori kurang | Tambah swap 2 GB atau naikkan RAM VPS |
| Login dashboard: "Token tidak dikenal" | Token dari lingkungan lain (demo/Mac) | Pakai token dari langkah 6 |
| Sensor: "kode pairing tidak valid" | Kode kedaluwarsa (15 menit) atau sudah dipakai | Buat kode baru di dashboard |
| Banyak 429 pada pairing | Percobaan kode salah > 10 dari satu alamat | Tunggu 15 menit atau restart API |
