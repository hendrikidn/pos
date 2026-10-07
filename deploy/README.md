# Deploy POS Guard di VPS yang sudah punya situs lain (Ubuntu 24.04)

PostgreSQL, API, dan dashboard berjalan dengan Docker Compose, terpisah dari situs yang sudah ada. POS **tidak memakai port 80/443** dan tidak menjalankan web server sendiri: web server yang sudah ada di VPS (nginx atau Caddy) meneruskan `pos.dolanyu.com` ke POS dan mengurus HTTPS-nya.

```
Internet ──HTTPS──► web server yang SUDAH ada (80/443)
                      ├─ dolanyu.com                 → proyek lama (tidak diubah)
                      ├─ goldenlamian.dolanyu.com    → proyek lama (tidak diubah)
                      ├─ pos.dolanyu.com              (untuk owner tenant, sensor, terminal POS)
                      │    ├─ /v1/*, /healthz ─► 127.0.0.1:18081 ─► API ──┐
                      │    └─ lainnya ─────────► 127.0.0.1:18082 ─► Dashboard owner
                      └─ pos-admin.dolanyu.com        (untuk Anda sebagai admin platform)
                           └─ semua ───────────► 127.0.0.1:18083 ─► Konsol admin ─► API
                                                                   PostgreSQL (internal Docker, tanpa port)
```

> **Deploy dan update: satu perintah, `~/pos/deploy/deploy.sh`** (langkah 5 dan 10). Sebelum yang pertama, selesaikan langkah 1–4 (DNS, pengguna, Docker, kode, `.env`).

> **Status:** konfigurasi ini **belum dijalankan di VPS sungguhan** dan Docker tidak tersedia di mesin pengembangan. Yang sudah diuji: instalasi dependensi yang difilter, API start dari hasil instalasi itu (migrasi otomatis, `/healthz`), build dan start dashboard produksi, serta alur API terhadap PostgreSQL 18 asli. **Belum terbukti:** build image, Compose, `deploy.sh` (logikanya diuji dengan Docker tiruan: jalur sukses, layanan gagal, cadangan gagal, konfigurasi salah), konfigurasi nginx/Caddy di bawah, `backup.sh`, dan prosedur pemulihan. Bila ada langkah yang gagal, salin pesan errornya.

## Apa yang bisa bentrok, dan apa yang tidak

| Sumber bentrok | Bentrok? | Alasan |
|---|---|---|
| Port 80/443 | **Tidak** | POS tidak membukanya; web server lama yang memakai |
| Port 3000/3001 (Node) | **Tidak** | Hanya ada di dalam jaringan Docker POS, tidak dipublikasikan ke host |
| Port 5432 (PostgreSQL) | **Tidak** | Database POS tidak punya port yang dipublikasikan; PostgreSQL proyek lain di host tidak tersentuh |
| Port 18081, 18082, 18083 | Jarang | Satu-satunya port POS di host, hanya di `127.0.0.1`. Cek dulu (langkah 0); ubah di `.env` bila terpakai |
| Nama container/volume/jaringan | **Tidak** | Semua berawalan `posguard_` / `posguard-` (`name: posguard`) |
| Docker | Perhatikan | Bila Docker belum terpasang, memasangnya mengubah aturan `iptables`. Biasanya aman, tapi lakukan di jam sepi |
| RAM/CPU | Mungkin | Build image dashboard butuh RAM besar sesaat; lihat bagian Troubleshooting |

## 0. Periksa kondisi VPS (hanya membaca)

```
sudo ss -tlnp | grep -E ':(80|443|3000|3001|3003|5432|18081|18082|18083)\b'    # siapa memakai port
sudo systemctl is-active nginx caddy apache2                          # web server mana yang aktif
docker --version 2>&1; docker ps 2>&1 | head                          # Docker sudah ada? proyek lama pakai Docker?
free -h; df -h /                                                      # RAM dan disk
```
Dari sini Anda tahu web server mana yang dipakai (nginx atau Caddy; bila Apache atau Traefik, beri tahu saya dan konfigurasinya saya sesuaikan) dan apakah port 18081–18083 kosong.

## 1. Arahkan DNS

Di pengelola DNS `dolanyu.com`, tambahkan record (record situs lama jangan diubah):

| Jenis | Nama | Nilai |
|---|---|---|
| A | `pos` | IP publik VPS (sama dengan situs lain) |
| A | `pos-admin` | IP publik VPS yang sama (untuk konsol admin platform) |

Cek dari komputer Anda: `dig +short pos.dolanyu.com` harus IP VPS.

> **Bila DNS dikelola Cloudflare:** set record `pos` ke **DNS only** (awan abu-abu), bukan Proxied. Dengan proxy Cloudflare, sertifikat yang dilihat sensor berasal dari Cloudflare dan rantainya bisa tidak cocok dengan bundel CA firmware.

## 2. Buat pengguna dan direktori khusus POS

Dari akun admin Anda (yang punya `sudo`):

```
sudo adduser --disabled-password --gecos "" posguard
sudo usermod -aG docker posguard        # setelah Docker terpasang (langkah 3)
sudo -iu posguard                       # masuk sebagai posguard (tanpa login SSH langsung)
```

Semua file POS berada di `/home/posguard/` dan tidak menyentuh direktori proyek lama:

```
/home/posguard/pos/        ← kode (git clone)
/home/posguard/backups/    ← cadangan database
```
Data database ada di volume Docker `posguard_pgdata` (di `/var/lib/docker/volumes/`), terpisah dari proyek lain.

**Catatan keamanan:** anggota grup `docker` setara dengan akses root atas mesin. Pengguna `posguard` memisahkan berkas dan kebiasaan kerja, tetapi **bukan** batas keamanan yang kuat bila `posguard` diretas. Bila Anda ingin isolasi sungguhan, pakai *rootless Docker* untuk `posguard` (`dockerd-rootless-setuptool.sh install`); beri tahu saya bila Anda mau langkah rincinya. Jangan beri `posguard` hak `sudo`.

## 3. Install Docker (lewati bila `docker --version` sudah menjawab)

Sebagai admin (bukan `posguard`):
```
sudo apt update && sudo apt install -y git curl ca-certificates
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker posguard
```
Firewall (`ufw`): tidak perlu membuka port baru. POS hanya memakai port yang sudah dibuka untuk situs lama.

## 4. Ambil kode dan isi pengaturan (sebagai `posguard`)

```
sudo -iu posguard
git clone https://github.com/hendrikidn/pos.git
cd pos/deploy
cp .env.example .env
nano .env
```
Di `.env`:
- `DOMAIN=pos.dolanyu.com`
- `POSTGRES_PASSWORD=` isi dengan hasil `openssl rand -hex 24`
- `API_PORT`, `DASHBOARD_PORT`, `ADMIN_PORT`: biarkan 18081/18082/18083 kecuali bentrok.
- `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: kredensial email untuk kode masuk (lihat langkah 6b: Brevo).
- Opsional: `CORS_ORIGINS` dan `WHATSAPP_*`.

Simpan sandi database di pengelola sandi Anda.

## 5. Jalankan (sebagai `posguard`)

```
~/pos/deploy/deploy.sh
```
Satu perintah ini: memeriksa `deploy/.env` dan Docker, menarik kode terbaru, mencadangkan database (bila sudah berjalan), membangun dan menjalankan semua layanan, menunggu semuanya sehat, lalu menguji API, dashboard, konsol admin, dan alamat publik. Build pertama 5–10 menit. Bila ada layanan yang tidak sehat, skrip menampilkan lognya, memberi cara kembali ke commit sebelumnya, dan keluar dengan status gagal.

Opsi: `--no-pull` (pakai kode yang ada di folder ini) dan `--no-backup` (lewati cadangan; tidak disarankan). Hasil akhirnya setara dengan memeriksa manual:
```
docker compose ps                         # db, api, dashboard, admin: running/healthy
curl http://127.0.0.1:18081/healthz       # {"ok":true}
```
Migrasi database berjalan otomatis saat API start. Pada tahap ini POS sudah hidup di VPS, tetapi baru bisa diakses dari VPS itu sendiri. Langkah 6 membukanya lewat domain.

## 6. Hubungkan web server yang sudah ada (sebagai admin)

Pilih sesuai langkah 0. **Jangan mengubah blok situs lama**; tambahkan blok baru untuk `pos.dolanyu.com` saja.

### nginx

Buat `/etc/nginx/sites-available/pos.dolanyu.com`:
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name pos.dolanyu.com;

    client_max_body_size 12m;     # laporan bank diunggah sampai 10 MB

    # API untuk sensor, terminal POS, dan dashboard
    location ~ ^/(v1/|healthz$) {
        proxy_pass http://127.0.0.1:18081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Dashboard owner
    location / {
        proxy_pass http://127.0.0.1:18082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Aktifkan, uji, lalu minta sertifikat Let's Encrypt:
```
sudo ln -s /etc/nginx/sites-available/pos.dolanyu.com /etc/nginx/sites-enabled/
sudo nginx -t                          # harus "syntax is ok"; bila gagal, JANGAN reload
sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx     # bila belum ada
sudo certbot --nginx -d pos.dolanyu.com
```
`certbot --nginx` menambahkan bagian HTTPS dan pengalihan otomatis. `nginx -t` dan `reload` tidak memutus situs lama.

### Konsol admin: `pos-admin.dolanyu.com`

Konsol admin berada di domain **terpisah** dari dashboard owner, jadi sesi, cookie, dan alamatnya tidak bercampur dengan pengguna tenant. Buat file nginx kedua:
```
sudo tee /etc/nginx/sites-available/pos-admin.dolanyu.com > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name pos-admin.dolanyu.com;

    # Opsional tetapi disarankan: batasi ke IP Anda. Ganti 203.0.113.10 dengan IP publik Anda, lalu hapus tanda #.
    # allow 203.0.113.10;
    # deny all;

    location / {
        proxy_pass http://127.0.0.1:18083;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/pos-admin.dolanyu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pos-admin.dolanyu.com
```
Konsol admin tidak meneruskan jalur API apa pun; ia berbicara ke API sendiri lewat jaringan internal Docker.

### Caddy (bila situs lama memakai Caddy)

Tambahkan blok ini ke Caddyfile yang ada (dan satu blok `pos-admin.dolanyu.com { reverse_proxy 127.0.0.1:18083 }` untuk konsol admin), lalu `sudo systemctl reload caddy`:
```
pos.dolanyu.com {
	tls {
		# Hanya Let's Encrypt: firmware sensor memverifikasi rantai Let's Encrypt (ISRG Root X1);
		# fallback ke penerbit lain bisa menghasilkan rantai yang ditolak sensor.
		ca https://acme-v02.api.letsencrypt.org/directory
	}
	@api path /v1/* /healthz
	handle @api {
		reverse_proxy 127.0.0.1:18081
	}
	handle {
		reverse_proxy 127.0.0.1:18082
	}
}
```

### Verifikasi

Dari komputer Anda:
```
curl https://pos.dolanyu.com/healthz        # {"ok":true}
```
Buka `https://pos.dolanyu.com/login` di browser; harus tanpa peringatan sertifikat. Situs lama harus tetap normal.

## 6b. Email kode masuk (Brevo)

Pengguna dashboard masuk dengan **email + password**. Email dipakai untuk **mengatur dan mengatur ulang password** (kode 6 digit) dan sebagai jalur masuk alternatif tanpa password. API mengirim email lewat SMTP; panduan ini memakai Brevo. Tanpa langkah ini kode tidak terkirim: pengguna baru tidak bisa mengatur password pertamanya, dan owner hanya bisa masuk dengan token cadangan.

1. Buat akun di [brevo.com](https://www.brevo.com).
2. **Verifikasi domain pengirim** (agar email tidak masuk spam atau ditolak). Di Brevo: *Senders, Domains & Dedicated IPs → Domains → Add a domain* → `dolanyu.com`. Brevo menampilkan beberapa record DNS (kode verifikasi TXT, DKIM, dan DMARC) yang Anda tambahkan di panel DNS `dolanyu.com`, lalu klik *Authenticate*. Setelah statusnya terotentikasi, `no-reply@dolanyu.com` boleh dipakai sebagai pengirim.
3. Ambil kredensial SMTP: *SMTP & API → tab SMTP*. Catat:
   - **SMTP login** (bentuknya `xxxxxx@smtp-brevo.com`; **bukan** email akun Anda),
   - **SMTP key**: klik *Generate a new SMTP key* (**bukan** sandi akun).
4. Isi `deploy/.env` (sebagai `posguard`):
   ```
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_USER=xxxxxx@smtp-brevo.com
   SMTP_PASS=xsmtpsib-...
   MAIL_FROM=POS Guard <no-reply@dolanyu.com>
   ```
5. Terapkan: `docker compose up -d api` (hanya API yang perlu dimulai ulang). Log API menampilkan `email kode masuk: SMTP smtp-relay.brevo.com:587, pengirim ...`; bila SMTP belum diisi tampil `PERINGATAN: SMTP_HOST belum diisi`.
6. Uji: buat tenant dengan email Anda sendiri di konsol admin (langkah 7), buka halaman masuk, pilih **Lupa password / atur password**, masukkan email, dan periksa kotak masuk (juga folder spam pada percobaan pertama).

Catatan:
- Rincian menu dan nama kolom di Brevo bisa berubah; ikuti petunjuk Brevo bila berbeda dari yang di atas. Paket gratis punya batas kiriman harian; cek batas saat ini di akun Anda dan pastikan cukup untuk jumlah login owner.
- Pakai port **587** (STARTTLS) atau **465** (`SMTP_SECURE=true`). Port 25 biasanya diblokir penyedia VPS.
- `SMTP_ALLOW_PLAIN=true` hanya untuk uji lokal dengan server SMTP tanpa TLS. **Jangan** dipakai di produksi: sandi SMTP akan terkirim tanpa enkripsi.
- Email kode masuk hanya dikirim bila email terdaftar dan aktif; respons di layar selalu sama agar daftar email pengguna tidak bisa ditebak.

## 7. Buat admin platform pertama, lalu buat tenant dari konsol

**Admin pertama hanya bisa dibuat lewat server** (belum ada siapa pun yang boleh masuk ke konsol). Sebagai `posguard`:
```
cd ~/pos/deploy
docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id hendrik --name "Hendrik"
```
Token ADMIN (`adm_...`) dicetak **sekali**; simpan di pengelola sandi. Token ini lebih kuat daripada token owner mana pun: ia bisa membuat tenant dan menerbitkan token owner untuk semua tenant.

Buka `https://pos-admin.dolanyu.com`, masuk dengan token admin, lalu **Tenant baru**:
1. Isi nama tenant, outlet pertama, terminal POS (mis. `pos-1, pos-2`), **email owner**, dan ID owner.
2. Klik **Buat tenant**. Dengan email owner, **tidak ada token** yang dibuat (centang "Terbitkan juga token owner" bila ingin jalur cadangan).
3. Pemilik membuka dashboard, memilih **Lupa password / atur password**, memasukkan emailnya, lalu kode 6 digit dari email beserta password baru (minimal 10 karakter; kalimat panjang boleh). Ia langsung masuk, dan berikutnya cukup email + password. Setelah masuk ia menambah staf, menu, dan memasang sensor di Pengaturan.

Tanpa email owner, perilaku lama berlaku: token owner muncul **sekali** dan dibagikan ke pemilik.

Pembagian tugas:

| Siapa | Mengelola |
|---|---|
| **Admin platform** (konsol `pos-admin`) | Tenant: buat, ganti nama, **tangguhkan/aktifkan**. **Pengguna dashboard**: tambah, ganti email, nonaktifkan (memutus sesinya). Token cadangan: terbitkan, cabut. Melihat **KPI** tiap tenant dan seluruh platform |
| **Owner tenant** (dashboard `pos`) | **Outlet** (tambah, ubah nama dan terminal, pajak, EDC), staf, menu, perangkat, dan **pengguna dashboard** (undang, ubah peran, ganti email, nonaktifkan; Pengaturan → Pengguna) |

**Peran pengguna dashboard** (sesuai yang diberlakukan API):

| Peran | Dapat | Dibuat oleh |
|---|---|---|
| **OWNER** | Semuanya: staf, menu, outlet, pengaturan, perangkat, pengguna, tinjau insiden, laporan bank | Admin platform |
| **OPS** | Meninjau insiden, mengunggah laporan bank dan slip settlement, mengelola menu, memasang perangkat | Owner atau admin |
| **MANAGER** | Melihat insiden, settlement EDC, dan menu (hanya baca) | Owner atau admin |
| **SUPERVISOR** | Melihat insiden saja (hanya baca) | Owner atau admin |

Insiden yang melibatkan seorang pengguna disembunyikan darinya, berdasarkan **ID pengguna**. Bila orang itu juga staf di POS, samakan ID pengguna dengan ID stafnya (kolom "ID staf POS" di form undangan). Owner tidak bisa membuat atau mengubah akun OWNER (termasuk dirinya sendiri) dan tidak bisa melihat pengguna tenant lain.

Admin tidak menambah atau mengubah outlet; itu dilakukan owner di **Pengaturan → Outlet**. Semua tindakan admin tercatat di `audit_log`.

**KPI di konsol** (tiap tenant dan ringkasan platform): pesanan dan penerimaan (hari ini, 7, dan 30 hari; chart harian 14 hari), perangkat online, insiden terbuka dan kritis, staf aktif, dan aktivitas terakhir. Definisinya:
- *Pesanan*: event `order.created`, tanpa pesanan karyawan. *Penerimaan*: pembayaran diterima dikurangi refund. Hari mengikuti zona waktu outlet.
- *Perangkat online*: terlihat dalam 5 menit terakhir; perangkat yang dicabut tidak dihitung.
- *Tenant tanpa aktivitas*: tenant aktif yang tidak ada perangkat terlihat dalam 7 hari terakhir.
- Event berstempel lebih dari sehari di masa depan diabaikan.

**Menangguhkan tenant** memutus semua token pengguna dan perangkatnya seketika (respons 403 "akun tenant ditangguhkan"), tanpa menghapus data. Owner melihat pesan itu saat masuk ke dashboard. Sensor yang ditangguhkan menampilkan `HTTP 403` di OLED dan menyimpan event di antrean sampai tenant diaktifkan lagi.

Token admin hilang: `docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id hendrik --rotate` (token lama langsung mati).

> Cara lama tanpa konsol (`apps/api/src/setup.ts`, membuat tenant dan token owner dari baris perintah) masih ada sebagai jalan darurat.

## 8. Menghubungkan sensor dan terminal

- Firmware sensor: `SERVER_URL "https://pos.dolanyu.com"` di `secrets.h`, lalu pairing seperti di panduan sensor. Sensor butuh WiFi yang punya internet (NTP dan HTTPS).
- Terminal POS: alamat API `https://pos.dolanyu.com`.

## 9. Cadangan database (sebagai `posguard`)

[backup.sh](backup.sh) membuat `pg_dump` dan menyimpan 14 hari.
```
chmod +x ~/pos/deploy/backup.sh
mkdir -p ~/backups
crontab -e
```
Tambahkan (jalan tiap hari 03:00):
```
0 3 * * * BACKUP_DIR=$HOME/backups $HOME/pos/deploy/backup.sh >> $HOME/backups/backup.log 2>&1
```
Cadangan di VPS yang sama **tidak cukup**: bila server hilang, cadangannya ikut hilang. Salin juga ke tempat lain, misalnya dari komputer Anda: `rsync -a posguard@IP-VPS:backups/ ~/cadangan-posguard/` (butuh akses SSH untuk `posguard`) atau dari akun admin menyalin `/home/posguard/backups`.

**Pulihkan** ke database kosong (**prosedur ini belum pernah dijalankan**; uji di VPS sebelum Anda membutuhkannya):
```
cd ~/pos/deploy
docker compose stop api dashboard
docker compose exec -T db psql -U posguard -d postgres -c "drop database if exists posguard with (force)" -c "create database posguard"
docker compose exec -T db psql -U posguard -d posguard -c "create role app_user nologin" || true
docker compose exec -T db pg_restore -U posguard -d posguard --no-owner < ~/backups/posguard-TANGGAL.dump
docker compose start api dashboard
```
Role `app_user` harus ada sebelum pemulihan karena hak aksesnya dirujuk oleh dump.

### Bersihkan database (mulai dari kosong)

Hanya untuk data uji. **Jangan dijalankan bila sudah ada data pelanggan nyata.** Menghapus **seluruh** data: tenant, outlet, perangkat, pengguna, pesanan, event, insiden, dan admin platform.

```
cd ~/pos && git pull
~/pos/deploy/reset-db.sh --admin hendrik "Hendrik"
```

Skrip mencadangkan database ke `~/backups` (bila cadangan gagal, tidak ada yang dihapus), meminta Anda mengetik `HAPUS`, membuat ulang database dan tabel lewat migrasi, lalu membuat admin platform dan mencetak tokennya. **Simpan token itu; hanya tampil sekali.**

| Opsi | Fungsi |
|---|---|
| `--admin ID "Nama"` | Buat admin platform setelah reset. Tanpa ini, tidak ada admin dan halaman admin tidak bisa dimasuki. |
| `--no-backup` | Lewati cadangan (data benar-benar hilang). |
| `--yes` | Lewati pertanyaan konfirmasi. |

Sesudahnya: masuk ke halaman admin dengan token, buat tenant baru, lalu buat kode pairing untuk sensor. Sensor yang sudah dipasang akan menerima 401 (`DITOLAK 401`) dan perlu direset (tahan BOOT 10 detik atau cabut-colok daya 5 kali), lalu dipairing ulang.

### Buat atau putar (rotate) token admin

Jalankan di server dari folder `deploy/`:

```
# Admin baru
docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id hendrik --name "Hendrik"

# Token hilang atau perlu diganti: token lama langsung mati
docker compose run --rm api node_modules/.bin/tsx apps/api/src/admin-token.ts --id hendrik --rotate
```

Token hanya tampil sekali. Bila muncul "admin sudah ada", ID itu sudah terdaftar: pakai `--rotate`.

## 10. Memperbarui versi (sebagai `posguard`)

```
~/pos/deploy/deploy.sh
```
Skrip yang sama dengan langkah 5, dan aman dijalankan berulang: mencadangkan database dulu (deploy dibatalkan bila cadangan gagal), menarik kode, membangun ulang, dan memeriksa kesehatan. Migrasi baru diterapkan otomatis; data di volume tidak tersentuh. Web server lama tidak perlu diubah.

**Kembali ke versi sebelumnya** (kode saja; migrasi database hanya maju, jadi bila versi lama tidak cocok dengan skema yang sudah berubah, pulihkan database dari cadangan di langkah 9):
```
cd ~/pos && git log --oneline | head     # pilih commit
git checkout <commit>
~/pos/deploy/deploy.sh --no-pull --no-backup
```
Kembali ke versi terbaru: `git checkout main && ~/pos/deploy/deploy.sh`.

## 11. Perintah sehari-hari (sebagai `posguard`, dari `~/pos/deploy`)

| Perlu | Perintah |
|---|---|
| Status | `docker compose ps` |
| Log API / dashboard | `docker compose logs -f api` / `dashboard` |
| Restart satu service | `docker compose restart api` |
| Matikan POS (data tetap; situs lain tidak terpengaruh) | `docker compose down` |
| **Jangan** | `docker compose down -v`: menghapus volume dan seluruh database |

## Keamanan

- Database tidak dipublikasikan; API dan dashboard hanya di `127.0.0.1`. Docker melewati aturan `ufw` untuk port yang dipublikasikan ke semua antarmuka, jadi **jangan** mengubah `127.0.0.1:` pada `ports:` menjadi tanpa alamat.
- HTTPS wajib: token perangkat dan token owner tidak boleh lewat HTTP polos di internet.
- Nginx/Caddy harus meneruskan `X-Forwarded-For` (sudah di contoh di atas). API memakai `TRUST_PROXY=1` (satu proxy tepercaya) untuk membedakan pemanggil pada pembatas percobaan kode pairing. Bila ada proxy lain di depan (mis. Cloudflare Proxied), jumlahnya perlu disesuaikan.
- API terhubung sebagai pemilik database, lalu `SET ROLE app_user` untuk isolasi per tenant (RLS). Itu rancangan yang disengaja.
- Token OWNER setara kunci utama satu tenant. Token **ADMIN** setara kunci utama seluruh platform: simpan di pengelola sandi, jangan dibagikan, dan terbitkan ulang (`--rotate`) bila bocor.
- **Password:** disimpan sebagai hash scrypt berasin (N=65536, r=8, p=1; parameter tersimpan di hash), minimal 10 karakter, maksimal 128, dan menolak yang terlalu umum, berulang, atau memuat nama email. **Akun dikunci 15 menit setelah 5 password salah berturut-turut**; kode email atau atur ulang password tetap bisa dipakai untuk masuk. Login gagal selalu berpesan sama dan berwaktu sama, baik email tak terdaftar, nonaktif, belum punya password, maupun password salah. Hash tidak terbaca dari jalur tenant (hak akses per kolom di database), tidak muncul di respons, dan tidak masuk log. Mengatur ulang atau mengganti password memutus sesi lain; mengganti email menghapus password lama.
- **Kode email:** 6 digit, berlaku 10 menit, sekali pakai, mati setelah 5 kali salah, disimpan sebagai hash berasin, dan hanya kode terbaru yang berlaku. Kode untuk masuk dan kode atur ulang password tidak saling menggantikan. Dibatasi 1 permintaan per menit dan 5 per jam per email, serta 20 permintaan dan 20 percobaan salah per 15 menit per alamat klien (alamat klien diteruskan dashboard dari nginx lewat `X-Forwarded-For`). Respons permintaan kode selalu sama agar daftar email tidak bisa ditebak.
- **Sesi:** 7 hari, dicabut saat keluar, saat pengguna dinonaktifkan, saat emailnya diganti, atau saat password diatur ulang. **Siapa pun yang menguasai kotak masuk email pengguna bisa mengatur ulang password-nya**, jadi sarankan owner memakai email dengan verifikasi dua langkah. Sandi SMTP ada di `.env`; jaga seperti rahasia lain.
- Konsol admin dipisahkan dari dashboard owner: domain berbeda, cookie berbeda (`SameSite=Strict`, sesi 12 jam), dan jenis token berbeda. Token admin ditolak di endpoint tenant dan sebaliknya (403). Pasang pembatasan IP di nginx (contoh di langkah 6) bila IP Anda tetap.
- Pembatas percobaan kode pairing disimpan di memori API, jadi reset saat API restart.

## Troubleshooting

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| `docker compose up` gagal: "port is already allocated" | 18081/18082 dipakai proses lain | Ganti `API_PORT`/`DASHBOARD_PORT` di `.env` dan di konfigurasi nginx/Caddy |
| `nginx -t` gagal | Salah ketik di blok baru | Perbaiki; **jangan** `reload` sebelum "syntax is ok" |
| `certbot` gagal | DNS belum mengarah ke VPS, atau port 80 tidak mencapai nginx | `dig +short pos.dolanyu.com`; periksa `ufw` dan firewall panel Contabo |
| `502 Bad Gateway` | API/dashboard belum siap atau crash | `docker compose ps` dan `logs api`; coba `curl http://127.0.0.1:18081/healthz` |
| Login dashboard: "asal permintaan tidak sah" | `Host` tidak diteruskan ke dashboard | Pastikan `proxy_set_header Host $host;` ada pada kedua `location` |
| Login dashboard: "Token tidak dikenal" | Token dari lingkungan lain (demo/Mac) | Pakai token dari langkah 7 |
| API restart terus | Sandi database di `.env` berubah setelah volume dibuat | Kembalikan sandi lama (sandi hanya dipakai saat volume pertama dibuat) |
| Login konsol admin: "Token tidak valid" | Memakai token owner (`api_`) | Konsol hanya menerima token admin (`adm_`) |
| `admin-token.ts`: "admin sudah ada" | ID admin sudah dibuat | Tambahkan `--rotate` untuk token baru |
| Akun terkunci ("terlalu banyak percobaan gagal untuk akun ini") | 5 password salah berturut-turut | Tunggu 15 menit, atau **Lupa password / atur password** (kode email) untuk langsung membuka kunci |
| Kode login tidak sampai | SMTP belum diisi, domain pengirim belum terotentikasi di Brevo, atau email tidak terdaftar/nonaktif | Lihat log `docker compose logs api` (cari `[mail]`); periksa folder spam; cek status domain di Brevo; pastikan email terdaftar di konsol admin |
| "terlalu banyak permintaan" saat login | Batas per alamat (20 per 15 menit) atau per email (5 per jam) | Tunggu; atau `docker compose restart api` mereset batas per alamat |
| Semua pengguna terkena batas bersamaan | nginx tidak meneruskan `X-Forwarded-For` | Pastikan `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` ada di blok `pos.dolanyu.com` |
| Build gagal / "Killed" | Memori kurang saat build dashboard | Tambah swap 2 GB (`fallocate -l 2G /swapfile`, `mkswap`, `swapon`) atau build saat situs lain sepi |
| Sensor: koneksi aman (HTTPS) gagal | Sertifikat belum terbit, domain salah, atau proxy Cloudflare aktif | Pastikan `https://pos.dolanyu.com/healthz` terbuka di browser; set DNS `pos` ke DNS only |
| Sensor: "kode pairing tidak valid" | Kode kedaluwarsa (15 menit) atau sudah dipakai | Buat kode baru di dashboard |
| Banyak 429 pada pairing | Percobaan kode salah > 10 dari satu alamat | Tunggu 15 menit atau `docker compose restart api` |
