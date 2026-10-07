# Instruksi Kerja: Memasang Sensor Kehadiran (ESP32-C3 + LD2410 + OLED) ke POS Guard

Panduan langkah demi langkah untuk pemula hardware (Mac). Sensor mengirim sesi kehadiran customer ke API POS Guard; hasilnya dipakai aturan deteksi fraud dan dilihat owner di dashboard.

```
LD2410 → ESP32-C3 → WiFi → API (POST /v1/events) → aturan fraud → dashboard owner
```

> **Status:** firmware sudah dikompilasi, tetapi **belum dijalankan di perangkat**, dan protokol frame LD2410 belum dicocokkan dengan modul asli. Anda mungkin yang pertama mengujinya. Bila ada langkah yang gagal, simpan log Serial Monitor dan foto OLED.

## Daftar isi

1. Komponen dan aturan keselamatan
2. Pasang pin header
3. Install software
4. Rakit (wiring)
5. Jalankan server dan dashboard
6. Unggah firmware
7. Pairing sensor (WiFi dan kode)
8. Pastikan sensor bekerja
9. Kalibrasi di outlet
10. Operasional: reset, ganti WiFi, cabut perangkat
11. Troubleshooting

---

## 1. Komponen dan aturan keselamatan

| Komponen | Fungsi |
|---|---|
| ESP32-C3 SuperMini | Mikrokontroler (otak) |
| HLK-LD2410B atau LD2410C | Sensor kehadiran mmWave 24 GHz |
| OLED 0,96" SSD1306 128x64 (I2C) | Layar status (opsional tapi disarankan) |
| Kabel USB-C **data** | Unggah firmware dan daya saat uji |
| Jumper Dupont | Penghubung antar modul |
| Kabel 1,27 mm ke Dupont | Hanya jika sensor versi "Tanpa Kabel" |
| Adaptor 5 V ≥ 1 A + kabel USB-C | Daya tetap di outlet |

**Aturan keselamatan**

1. Cabut USB sebelum mengubah kabel.
2. Jangan sampai VCC dan GND bersentuhan.
3. Jangan beri 5 V ke pin 3V3 atau GPIO.
4. Jangan colok USB dan supply 5 V eksternal bersamaan.
5. Di outlet, beri sensor **adaptor 5 V sendiri**, jangan dari USB POS, agar mematikan POS tidak mematikan sensor.

## 2. Pasang pin header

1. Solder pin header ke ESP32-C3 dan OLED jika belum terpasang.
2. Tanpa solder, pin bisa dijepit di breadboard hanya untuk percobaan sementara.
3. Soket LD2410 berjarak **1,27 mm** (5 pin), bukan 2,54 mm. Varian "Tanpa Kabel" perlu kabel adaptor 1,27 mm ke Dupont. Varian "Test Board" berguna untuk menyetel dari PC, tetapi bukan pengganti kabel ke ESP32.

## 3. Install software

### 3.1 Mac Apple Silicon: install Rosetta (sekali)

```
softwareupdate --install-rosetta --agree-to-license
```

Tanpa ini, beberapa tool berhenti dengan `bad CPU type in executable`.

### 3.2 PlatformIO (untuk firmware)

Firmware project ini memakai **PlatformIO**, bukan Arduino IDE. Pilih salah satu:

**A. Lewat VS Code (paling mudah)**
1. Buka Extensions (Cmd+Shift+X), cari **PlatformIO IDE**, Install, lalu restart VS Code.
2. Buka folder `firmware/sensor-node`. Build/Upload/Monitor ada di ikon PlatformIO di sidebar.

**B. Lewat Terminal**
```
python3 -m pip install --user platformio
```
Jika muncul `externally-managed-environment`:
```
python3 -m venv ~/pio-venv
~/pio-venv/bin/pip install platformio
```
Lalu jalankan dengan jalur lengkap, mis. `~/pio-venv/bin/pio run -e esp32c3`.

> Di macOS perintah `pip` sering tidak ada; pakai `pip3` atau `python3 -m pip`. Jika `python3` juga tidak ada: `xcode-select --install`.

Kompilasi pertama mengunduh sekitar 2 GB dan butuh belasan menit. Jangan dihentikan.

### 3.3 Dependensi project

Di folder project:
```
npm install
```

## 4. Rakit (wiring)

**Cabut USB dulu.** Pin mengikuti firmware project (dapat diubah di `firmware/sensor-node/app/config.h`).

**LD2410 ke ESP32-C3 (UART)**

| LD2410 | ESP32-C3 SuperMini |
|---|---|
| 5V | 5V |
| GND | GND |
| TX | **GPIO4** |
| RX | **GPIO3** |
| OUT | tidak dipakai |

**OLED ke ESP32-C3 (I2C)**

| OLED | ESP32-C3 SuperMini |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO8 |
| SCL | GPIO9 |

Catatan:
- Sensor butuh **5 V**; logika TX/RX 3,3 V, aman langsung ke ESP32.
- TX dan RX **disilang**: TX sensor ke GPIO4 (RX ESP), RX sensor ke GPIO3 (TX ESP).
- Cek urutan pin di silkscreen OLED (bisa `GND VCC SCL SDA`).
- GPIO9 juga tombol BOOT. Menekan BOOT mengganggu layar selama ditekan, tidak lebih.

> Panduan lama memakai GPIO20/21 untuk sensor. **Jangan dipakai**: firmware project ini memakai GPIO4/GPIO3.

## 5. Jalankan server dan dashboard

Untuk uji di komputer (tanpa server produksi):

```
npm run demo        # terminal 1: API dengan data simulasi; mencetak token OWNER
npm run dashboard   # terminal 2: dashboard di http://localhost:3001
```

1. Buka http://localhost:3001 dan tempel token **OWNER** yang dicetak `npm run demo`.
2. Cari IP Mac Anda di jaringan WiFi (dipakai sensor sebagai alamat server):
   ```
   ipconfig getifaddr en0
   ```
3. Mac dan sensor harus berada di **WiFi yang sama**, dan WiFi itu harus **2,4 GHz**.

> **`npm run demo` hanya untuk mencoba.** Database-nya di memori: data, token OWNER, dan sensor yang sudah dipasang **hilang** saat dihentikan, dan setelah itu sensor harus dipasang ulang. Untuk pemakaian tetap pakai PostgreSQL (lihat 5.1). IP Mac juga bisa berubah; cek ulang bila sensor tidak tersambung.

### 5.1 Pemakaian tetap dengan PostgreSQL

1. Install [Postgres.app](https://postgresapp.com), jalankan, dan buat database `posguard` (klik dua kali pada database default lalu jalankan `create database posguard;`, atau lewat `psql`).
2. **Admin platform:** buat admin pertama, lalu buat tenant dan token owner dari UI, tanpa token manual.
   ```
   export DATABASE_URL=postgres://USER@localhost:5432/posguard
   npm run api:admin -- --id hendrik --name "Hendrik"        # mencetak token ADMIN (adm_...) sekali
   ```
   Jalankan API dan konsol admin (`npm run api`, `npm run admin`), buka http://localhost:3003, masuk dengan token admin, lalu **Tenant baru**. Isi **email owner**: dashboard (http://localhost:3001) lalu dimasuki dengan email itu, dan kode 6 digit dicetak di konsol API (mode demo memakai pengirim konsol; produksi lewat SMTP, lihat deploy/README.md). Tanpa email, token owner yang muncul dipakai untuk masuk (langkah 4).
   Cara lama lewat baris perintah (opsional): siapkan database sekali (ganti `USER` dengan nama pengguna Mac Anda, yang menjadi superuser bawaan Postgres.app):
   ```
   export DATABASE_URL=postgres://USER@localhost:5432/posguard
   npm run api:setup -- --tenant usahaku --tenant-name "Usahaku" --outlet senopati --outlet-name "Kopi Senopati" --terminals pos-1,pos-2
   ```
   Token OWNER dicetak **sekali**; simpan. Menjalankan perintah lagi aman dan menerbitkan token OWNER baru (bila token hilang).
3. Jalankan API dan dashboard:
   ```
   DATABASE_URL=postgres://USER@localhost:5432/posguard npm run api    # terminal 1
   npm run dashboard                                                     # terminal 2
   ```
4. Login dashboard dengan token OWNER dari langkah 2, lalu lanjut ke langkah 6 dan 7. Sensor yang sudah dipasang tetap terpasang setelah API di-restart.

Catatan: API dengan `DATABASE_URL` tidak memuat data contoh; dashboard kosong sampai sensor dan terminal mengirim event.

## 6. Unggah firmware

1. Salin `firmware/sensor-node/app/secrets.example.h` menjadi `firmware/sensor-node/app/secrets.h`.
2. Isi **hanya** alamat server:
   ```cpp
   #define SERVER_URL "https://pos.dolanyu.com"     // produksi (VPS), HTTPS
   // uji lokal tanpa VPS: "http://IP-MAC:3000"     (tanpa enkripsi, hanya untuk jaringan lokal)
   ```
   WiFi, token, dan identitas perangkat **tidak** diisi di sini; semuanya lewat pairing (langkah 7).
3. Colok sensor ke komputer dengan USB-C **data**.
4. Unggah (sekali, lewat USB):
   ```
   cd firmware/sensor-node
   pio run -e esp32c3 -t upload
   pio device monitor
   ```
   (atau tombol Upload dan Monitor di PlatformIO VS Code)

Bila upload gagal: tahan **BOOT**, tekan **RESET** sekali, lepas BOOT, unggah ulang.

## 7. Pairing sensor (WiFi dan kode)

Satu firmware untuk semua sensor. Token dibuat server dan disimpan di flash sensor; tidak ada di kode.

1. **Dashboard → Pengaturan → Perangkat → Tambah perangkat.**
   Pilih outlet, jenis **Sensor kehadiran**, dan terminal yang disangga (mis. `pos-1`). Klik **Buat kode pairing**.
2. Catat kode 8 karakter (mis. `VMWW-SRC2`). Berlaku **15 menit**, **sekali pakai**, dan tidak ditampilkan lagi.
3. Nyalakan sensor. Karena belum dipasang, OLED menampilkan **SETUP SENSOR**, nama WiFi `POSGUARD-xxxx`, dan sandinya.
4. Di HP, sambung ke WiFi `POSGUARD-xxxx` memakai sandi di OLED. Portal terbuka otomatis; bila tidak, buka `http://192.168.4.1`.
5. Pilih WiFi outlet (2,4 GHz), isi sandinya dan kode pairing, lalu **Pasang perangkat**.
6. Sensor menyambung ke WiFi, menukar kode dengan token, menyimpannya, dan restart. OLED menampilkan **TERPASANG**.
7. Di dashboard, sensor muncul **Online** di daftar perangkat.

Catatan:
- HP bisa terputus sebentar dari WiFi `POSGUARD-xxxx` saat sensor pindah channel; itu normal. Hasilnya juga terlihat di OLED dan dashboard.
- Kode salah atau kedaluwarsa: buat kode baru. Salah kode 10 kali dari alamat yang sama dalam 15 menit ditolak sementara.

**Mode uji tanpa pairing (opsional):** definisikan `WIFI_SSID`, `WIFI_PASS`, `DEVICE_ID`, `DEVICE_TOKEN`, `OUTLET_ID` (dan `TERMINAL_ID`) di `secrets.h` dengan token dari `npm run demo`. Hanya dipakai bila flash belum berisi identitas. Jangan dipakai di produksi.

**Beberapa kasir:** ulangi langkah 7 untuk tiap terminal (buat kode baru, `terminal` berbeda: `pos-2`, `pos-3`, dan seterusnya). Satu sensor melayani satu kasir/terminal.

## 8. Pastikan sensor bekerja

Layar OLED (5 baris): status WiFi dan waktu (NTP), status radar, ada/tidaknya customer dan jaraknya, jumlah sesi dan antrean, hasil pengiriman terakhir.

| Tampilan | Arti |
|---|---|
| `WiFi:ok Waktu:ok` | Tersambung dan jam sinkron. Sebelum jam sinkron, sesi dibuang dengan sengaja |
| `Radar: ok` | Frame sensor terbaca |
| `Radar: no_radar` | Tidak ada frame > 5 detik: periksa TX/RX (disilang), 5 V, pin GPIO4/GPIO3 |
| `Radar: blocked` | Sensor tertutup atau menempel pada benda |
| `Kirim: OK n` | Event diterima server |
| `Kirim: DITOLAK 401` | Token dicabut atau salah: reset pabrik dan pairing ulang |

Tes: berdiri di depan sensor, lalu menjauh. Setelah beberapa detik muncul log `sesi: N s` di Serial Monitor dan jumlah **Sesi** di OLED bertambah. Sesi dimulai setelah ada terus-menerus 2 detik dan berakhir setelah tidak ada 5 detik.

## 9. Kalibrasi di outlet

Zona dan ambang bergantung pada tempat. **Jangan memakai nilai bawaan di outlet nyata.**

1. Unggah mode kalibrasi: `pio run -e esp32c3-calibrate -t upload`. Firmware mencetak baris CSV lewat USB serial.
2. Rekam tiga keadaan ke berkas, mis. `pio device monitor | tee kosong.csv`:
   - `kosong.csv`: konter tanpa siapa pun, 2–3 menit, termasuk orang lalu-lalang di kejauhan.
   - `customer.csv`: 3–5 orang berdiri bergantian di tempat membayar, ±20 detik masing-masing.
   - `kasir.csv`: hanya kasir bekerja di belakang konter, tanpa customer, 3–5 menit.
3. Jalankan:
   ```
   npx tsx firmware/sensor-node/tools/calibrate.ts kosong.csv customer.csv kasir.csv
   ```
   Salin nilai `#define` yang disarankan ke `firmware/sensor-node/app/config.h`.
4. Unggah ulang firmware biasa (`-e esp32c3`). Identitas dan token tetap tersimpan, tidak perlu pairing ulang.
5. Pantau 1–2 minggu dalam **mode shadow** (alert belum dipakai) sebelum mengandalkan aturan R1 dan R3.

**Penempatan:** arahkan ke area berdiri customer di depan kasir, dari sisi konter yang tidak menghadap kasir. Radar menembus plastik dan akrilik tetapi tidak logam. Hindari kipas, tirai, dan pintu otomatis di depan sensor. Kasir di belakang konter juga terdeteksi radar, jadi zona jarak harus mencakup area customer saja.

## 10. Operasional

| Kebutuhan | Cara |
|---|---|
| **Daya tetap** | Colok USB-C ke adaptor 5 V ≥ 1 A, atau 5 V ke pin **5V** dan GND ke pin **GND**. Pilih salah satu |
| **Ganti WiFi / pindah outlet / token ditolak** | Tahan **BOOT 10 detik** saat sensor jalan. Identitas, WiFi, dan antrean event dihapus, lalu sensor kembali ke portal. Buat kode pairing baru. Jangan menahan BOOT saat menyalakan (itu mode unggah firmware) |
| **Sensor hilang / dicuri** | Dashboard → Pengaturan → Perangkat → **Cabut** (owner). Token langsung ditolak; event lama tetap tersimpan |
| **Batalkan kode yang belum dipakai** | Dashboard → bagian "Menunggu dipasang" → Batalkan |
| **Offline lama** | Event tersimpan di flash dan dikirim ulang saat tersambung. Bila antrean > 256 KB, detak dihentikan; sesi tetap disimpan |

## 11. Troubleshooting

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| `pip: command not found` | macOS memakai `pip3` | `python3 -m pip install --user platformio`, atau pakai ekstensi PlatformIO di VS Code |
| `bad CPU type in executable` | Rosetta belum terpasang | `softwareupdate --install-rosetta --agree-to-license` |
| Port tidak muncul | Kabel hanya untuk charger | Ganti kabel data; coba mode BOOT/RESET |
| Upload gagal | Board tidak masuk mode flash | Tahan BOOT, tekan RESET, lepas BOOT, unggah ulang |
| Kompilasi lama sekali | Unduhan toolchain pertama (±2 GB) | Tunggu; berikutnya hanya ±20 detik |
| OLED kosong | SDA/SCL tertukar, atau VCC salah | Periksa kabel; OLED di 3V3, SDA GPIO8, SCL GPIO9 |
| `Radar: no_radar` | TX/RX tidak disilang, tanpa 5 V, atau pin salah | TX sensor ke GPIO4, RX sensor ke GPIO3, sensor ke 5V |
| Portal `POSGUARD-xxxx` tidak muncul | Sensor sudah terpasang | Reset pabrik (BOOT 10 detik) |
| "Gagal tersambung ke WiFi" di portal | WiFi 5 GHz, atau sandi salah | Pakai WiFi 2,4 GHz, periksa sandi |
| "Koneksi aman (HTTPS) ... gagal" | Jam belum sinkron, domain salah, atau sertifikat server tidak sah (mis. sertifikat belum terbit di web server) | Pastikan `https://pos.dolanyu.com/healthz` terbuka di browser; WiFi sensor harus punya internet (NTP) |
| "Jam tidak bisa disinkronkan" | WiFi tanpa akses internet (NTP diblokir) | Pakai WiFi yang punya internet; sertifikat HTTPS tidak bisa divalidasi tanpa jam |
| "Tidak bisa menghubungi server" | `SERVER_URL` salah, API mati, atau beda jaringan | Cek IP Mac (`ipconfig getifaddr en0`), pastikan `npm run demo` jalan, satu WiFi |
| "kode pairing tidak valid" | Kode salah, kedaluwarsa, atau sudah dipakai | Buat kode baru di dashboard |
| `Kirim: DITOLAK 401` | Token dicabut atau data demo direset | Reset pabrik dan pairing ulang |
| Sensor tidak muncul di dashboard | Belum ada event, atau server demo di-restart | Tunggu ±30 detik (detak); setelah restart demo, pairing ulang |
| Board panas | Hubung singkat | Cabut USB, periksa kabel |

## Batas yang perlu diketahui

- HTTP polos hanya untuk jaringan uji. Produksi wajib HTTPS (`https://pos.dolanyu.com`): firmware memvalidasi sertifikat terhadap bundel root CA bawaan. HTTPS **belum dijalankan di perangkat** (hanya dikompilasi dan bundelnya diverifikasi di komputer). Penyematan sertifikat (pinning) belum ada.
- Tanda tangan event dengan kunci perangkat (eFuse/HMAC) belum ada di sensor: pemegang token yang tahu format rantai bisa memalsukan event.
- Radar mendeteksi keberadaan, bukan identitas. Alert dari sensor adalah indikasi untuk dicek dengan CCTV.

Server produksi di VPS (Docker, HTTPS): [deploy/README.md](deploy/README.md).

Rujukan lengkap: [firmware/sensor-node/README.md](firmware/sensor-node/README.md) dan [README.md](README.md).
