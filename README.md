# POS Guard

POS F&B dengan deteksi fraud kasir. Perencanaan ada di [docs/](docs/): [SPEC-MVP](docs/SPEC-MVP.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [BANK-REPORT-FORMAT](docs/BANK-REPORT-FORMAT.md).

## Status

Tahap 1 (rekonsiliasi non-tunai), tahap 2 (event log, kunci order, aturan real-time, skoring insiden), tahap 3 (backend API), tahap 4 (dashboard owner), tahap 5 (aplikasi POS), dan tahap 6 (firmware sensor) ada. Firmware sensor dan akses perangkat keras nyata (printer, laci, kios) **belum diuji di perangkat**, dan WhatsApp belum diuji ke API sungguhan. Tidak bergantung pada pilihan hardware.

| Paket | Isi |
|---|---|
| `packages/domain` | Tipe kanonik (`BankTxn`, `PosPayment`), deduplikasi |
| `packages/bank-parsers` | Parser BCA, BRI, Mandiri (format mock per transaksi) + slip settlement Mandiri (format asli, ringkasan batch) |
| `packages/reconciliation` | Pencocokan POS ↔ bank per transaksi (R7, R8, R26, R10) dan per batch settlement (R27, R28) |
| `packages/events` | Tipe event, rantai hash per perangkat, deteksi event hilang/diubah/jam bergeser |
| `packages/order` | State machine order dan kunci void, diskon (approver, owner, ambang) |
| `packages/rules` | Aturan real-time R1–R5, R5b, R18, R21–R25, pengelompokan insiden, skor dan level |
| `packages/sim` | Simulator aliran event outlet untuk test dan demo |
| `apps/api` | Backend NestJS + PostgreSQL: ingest event, rekonsiliasi bank, insiden, review, notifikasi |
| `apps/dashboard` | Dashboard owner (Next.js): daftar insiden, bukti, jendela CCTV, review |
| `apps/admin` | Konsol admin platform (Next.js, UI terpisah dari dashboard owner): membuat dan menangguhkan tenant, menerbitkan atau mencabut token owner, dan **KPI tenant** (pesanan, penerimaan, perangkat, insiden). Outlet dikelola owner tenant di dashboard-nya. Token `adm_`, dibuat lewat `npm run api:admin` |
| `packages/pos-core` | Inti POS tanpa DOM: order, kunci void/diskon/refund, shift buta, event log + outbox, sinkronisasi |
| `apps/pos/android` | Pembungkus Android (Capacitor): printer ESC/POS, Keystore, postur, kios, layar kedua. Lihat [ANDROID.md](apps/pos/ANDROID.md) |
| `firmware/sensor-node` | Firmware sensor kehadiran (ESP32-C3 + LD2410): inti C yang diuji di komputer, aplikasi ESP32, alat kalibrasi |
| `apps/pos` | Aplikasi POS (React/Vite): login PIN, order, dapur, bayar, struk, void dengan persetujuan, shift, layar customer |

## Mencoba tanpa hardware

```
npm run demo        # terminal 1: API dengan data simulasi; mencetak token OWNER dan MANAGER
npm run dashboard   # terminal 2: dashboard di http://localhost:3001
npm run pos         # terminal 3: aplikasi POS di http://127.0.0.1:3002; tempel token perangkat (dicetak oleh npm run demo) di layar "Hubungkan terminal". Staf, PIN, dan menu diunduh dari server (build dulu: npm run build -w @pos/dashboard untuk mode produksi)
```

Tempel token OWNER di halaman login dashboard; di **Pengaturan** owner mengelola staf, PIN, menu, dan EDC. Token disimpan di cookie httpOnly dan hanya dikirim dari server dashboard ke API. Login sebagai MANAGER untuk melihat mode hanya-baca.

**Server produksi di VPS (Docker Compose + HTTPS):** lihat [deploy/README.md](deploy/README.md).

## Pemakaian tetap (PostgreSQL)

`npm run demo` memakai database di memori: data dan token hilang saat dihentikan. Untuk pemakaian tetap, API dijalankan dengan PostgreSQL.

1. Siapkan PostgreSQL (di Mac: [Postgres.app](https://postgresapp.com), lalu buat database `posguard`). Pengguna database harus boleh membuat role (migrasi membuat `app_user`); pengguna superuser bawaan Postgres.app sudah cukup.
2. Siapkan database sekali: migrasi, tenant, outlet, dan token OWNER.
   ```
   export DATABASE_URL=postgres://USER@localhost:5432/posguard
   npm run api:setup -- --tenant usahaku --tenant-name "Usahaku" --outlet senopati --outlet-name "Kopi Senopati" --terminals pos-1,pos-2
   ```
   Token OWNER dicetak **sekali**. Menjalankan perintah lagi aman: tenant dan outlet yang ada dibiarkan, dan token OWNER baru terbit (cara memulihkan token yang hilang; token lama tetap berlaku).
3. Jalankan API dan dashboard (terminal terpisah):
   ```
   DATABASE_URL=postgres://USER@localhost:5432/posguard npm run api
   npm run dashboard
   ```
4. Login dashboard dengan token OWNER, lalu pasang sensor di **Pengaturan → Perangkat**. Token perangkat dibuat server saat pairing dan ikut tersimpan permanen.

Untuk database hosting (Neon, Supabase, dan sejenisnya), pakai alamat koneksi dengan `?sslmode=require`. Diuji terhadap PostgreSQL 18 asli: migrasi, isolasi tenant (RLS), pairing, dan data bertahan setelah API di-restart.

## Backend (`apps/api`)

Tanpa `DATABASE_URL`, API memakai PostgreSQL in-memory (PGlite) sehingga bisa dicoba tanpa memasang database. Dengan `DATABASE_URL`, API memakai PostgreSQL server; koneksi harus boleh `SET ROLE app_user` (dibuat oleh migrasi) karena isolasi tenant memakai RLS.

| Endpoint | Pemanggil | Fungsi |
|---|---|---|
| `POST /v1/events` | perangkat (`dev_...`) | Kirim batch event (maks. 500). Idempoten per (perangkat, seq) |
| `POST /v1/outlets/:id/bank-reports` | OWNER, OPS | Unggah laporan bank `{text, filename}`; rekonsiliasi berjalan ulang |
| `POST /v1/outlets/:id/evaluate` | OWNER, OPS | Evaluasi ulang aturan |
| `GET /v1/outlets/:id/incidents` | pengguna (`api_...`) | Daftar insiden (tanpa yang melibatkan pengguna itu sendiri) |
| `GET /v1/incidents/:id`, `POST /v1/incidents/:id/review` | pengguna / OWNER, OPS | Detail dan review (`CONFIRMED_FRAUD`, `LEGIT`, `FALSE_ALARM`, `INCONCLUSIVE`) |
| `POST/GET/DELETE /v1/notification-recipients` | OWNER | Kelola penerima notifikasi insiden kritis (nomor 8–15 digit tanpa `+`) |
| `POST/GET /v1/devices/pairing`, `DELETE /v1/devices/pairing/:deviceId` | OWNER, OPS | Buat, lihat, dan batalkan kode pairing perangkat (8 karakter, sekali pakai, berlaku 15 menit; hanya hash yang disimpan). Kode polos hanya muncul di respons pembuatan |
| `POST /v1/device/enroll` | perangkat baru (tanpa token) | Menukar kode pairing dengan `{deviceId, token, outletId, terminalId}`. Token dibuat server. Salah kode dibatasi 10 kali per 15 menit per alamat |
| `GET /v1/devices`, `POST /v1/devices/:id/revoke` | OWNER, OPS (cabut: OWNER) | Daftar perangkat dan status; mencabut token (event lama tetap tersimpan). Halaman dashboard: **Pengaturan → Perangkat** |
| `GET/POST/PUT /v1/staff` | OWNER | Staf dan PIN. PIN 4–6 digit, ditolak bila sama semua atau berurutan, disimpan sebagai hash PBKDF2 berasin |
| `GET/POST/PUT /v1/menu` | OWNER, OPS | Menu. Perubahan harga dicatat di audit_log beserta harga lama dan baru |
| `GET/PUT /v1/outlets/:id/settings` | OWNER | Nama merchant, pajak, EDC terdaftar, ambang persetujuan, retensi CCTV |
| `POST/GET /v1/outlets/:id/settlements` | OWNER, OPS (baca: + MANAGER) | Slip settlement EDC: `{text}` (isi slip) atau `{slip}` (isian terstruktur). Dicocokkan per batch dengan POS (R27, R28); TID harus terdaftar |
| `GET /v1/device/config` | terminal (`dev_...`) | Konfigurasi terminal: pengaturan, staf aktif (hash PIN), menu aktif, dengan `?version=` untuk menghindari unduhan ulang |

**Notifikasi.** Insiden kritis (termasuk yang naik ke kritis karena bukti tambahan) dikirim sekali ke owner/ops aktif untuk outlet itu, kecuali orang yang terlibat di insiden. Tanpa konfigurasi, pesan hanya dicatat di log. WhatsApp aktif jika `WHATSAPP_TOKEN` dan `WHATSAPP_PHONE_NUMBER_ID` diisi (opsional `WHATSAPP_TEMPLATE`, `WHATSAPP_LANGUAGE`, `DASHBOARD_URL`). Pengiriman ke WhatsApp **belum diuji terhadap API sungguhan**.

> Parser memakai format **mock** di `fixtures/bank-reports/`. Ganti dan sesuaikan setelah contoh laporan asli diperoleh (lihat daftar periksa di BANK-REPORT-FORMAT.md).

## Perintah

```
npm install
npm test
npm run typecheck
npm run api      # menjalankan API di http://localhost:3000 (data kosong)
```
