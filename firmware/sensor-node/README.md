# Sensor kehadiran customer (ESP32-C3 + LD2410)

Mengubah radar mmWave HLK-LD2410 menjadi **sesi kehadiran customer** di depan kasir, lalu mengirimnya ke API sebagai event `presence.session` bertanda rantai hash. Dipakai aturan R1, R3, R21, R25.

## Status

| Bagian | Status |
|---|---|
| Pembaca frame LD2410, detektor sesi, pembuat event (`core/`, C99) | Diuji di komputer: 27 tes, termasuk **verifikasi silang** bahwa hash dan rantai event dari C diterima `verifyChain` TypeScript dan ingest API sungguhan |
| Alat kalibrasi (`tools/calibrate.ts`) | Diuji dengan data sintetis |
| Aplikasi ESP32 (`app/`: portal pairing, HTTPS, Wi-Fi, NTP, antrean di flash, OLED) | **Berhasil dikompilasi** untuk ESP32-C3 (kedua env; flash 84% dari 1,3 MB, RAM 13%), tanpa peringatan. **Belum dijalankan di perangkat** |
| Protokol frame LD2410 | Ditulis dari pengetahuan protokol serial pabrikan, **belum dicocokkan dengan modul asli**. Ini hal pertama yang diuji saat modul tiba |

## Perangkat keras

| Komponen | Catatan |
|---|---|
| ESP32-C3 SuperMini | Sebagian klon punya antena Wi-Fi yang tidak stabil pada daya penuh; `WIFI_TX_POWER` di `config.h` sudah diturunkan |
| HLK-LD2410B atau LD2410C | Protokol frame data sama. Modul **5 V**, logika 3,3 V |
| OLED SSD1306 128×64 I2C | Opsional, untuk status dan kalibrasi |
| Adaptor 5 V ≥ 1 A (adaptor ponsel) + kabel USB-C | **Daya terpisah dari USB POS**, agar mematikan POS tidak mematikan sensor |

### Pengkabelan

```
LD2410            ESP32-C3 SuperMini
  5V   ─────────── 5V
  GND  ─────────── GND
  TX   ─────────── GPIO4 (RX1)
  RX   ─────────── GPIO3 (TX1)
  OUT  ─────────── (tidak dipakai)

OLED SSD1306
  VCC → 3V3   GND → GND   SDA → GPIO8   SCL → GPIO9
```

Pin dapat diubah di `app/config.h`.

**Periksa sebelum merakit:**
- Soket modul LD2410 berjarak **1,27 mm** (5 pin), bukan 2,54 mm. Varian "tanpa kabel" membutuhkan kabel/adaptor 1,27 mm ke Dupont atau disolder langsung.
- "Test board" berguna untuk menyetel modul dari PC dengan aplikasi pabrikan, tetapi bukan pengganti kabel ke ESP32.

## Memasang (pairing)

Satu firmware untuk semua sensor. WiFi, token, dan identitas perangkat **tidak ada di firmware**; semuanya disimpan di flash setelah pairing.

1. Salin `app/secrets.example.h` menjadi `app/secrets.h` dan isi `SERVER_URL` (alamat API; ini satu-satunya yang tertanam).
2. `pio run -e esp32c3 -t upload` (sekali, lewat USB), lalu `pio device monitor`.
3. Di dashboard: **Pengaturan → Perangkat → Buat kode pairing** (pilih outlet, jenis Sensor, dan terminal yang disangga, mis. `pos-1`). Catat kode 8 karakter; berlaku 15 menit, sekali pakai.
4. Nyalakan sensor. Karena belum dipasang, OLED menampilkan **SETUP SENSOR**, nama WiFi `POSGUARD-xxxx`, dan sandinya.
5. Dari HP, sambung ke WiFi itu (portal terbuka otomatis, atau buka `http://192.168.4.1`). Pilih WiFi outlet (2,4 GHz), isi sandinya dan kode pairing, lalu **Pasang perangkat**.
6. Sensor menyambung ke WiFi, menukar kode dengan token ke server, menyimpannya, dan restart. Perangkat muncul **Online** di dashboard.

**Reset pabrik:** tahan tombol BOOT 10 detik saat sensor berjalan. Identitas, WiFi, dan antrean/rantai event dihapus, lalu sensor kembali ke portal setup. Pakai ini juga bila token dicabut (OLED menampilkan `Kirim: DITOLAK 401`) atau sensor dipindah outlet. Jangan menahan BOOT saat menyalakan: itu masuk mode unggah firmware.

**Mode uji tanpa pairing:** definisikan `WIFI_SSID`, `WIFI_PASS`, `DEVICE_ID`, `DEVICE_TOKEN`, `OUTLET_ID` (dan `TERMINAL_ID`) di `secrets.h` dengan token dari `npm run demo`. Dipakai hanya bila flash belum berisi identitas; tidak disimpan ke flash.

**Penempatan:** arahkan ke area berdiri customer di depan kasir, dari sisi konter yang tidak menghadap kasir. Radar menembus plastik dan akrilik tetapi tidak logam. Hindari kipas, tirai, dan pintu otomatis di depan sensor. Kasir yang bekerja di belakang konter juga terdeteksi radar, jadi zona jarak harus dipilih agar hanya mencakup area customer.

## Kalibrasi (Fase 0)

Ambang dan zona bergantung pada tempat. Jangan memakai bawaan di outlet nyata.

1. Bangun mode kalibrasi: `pio run -e esp32c3-calibrate -t upload`. Firmware mencetak baris `CSV,ts,status,jarak_gerak,energi_gerak,jarak_diam,energi_diam,di_zona` lewat USB serial.
2. Rekam tiga keadaan ke berkas (mis. `pio device monitor | tee kosong.csv`):
   - `kosong.csv`: konter tanpa siapa pun, 2–3 menit, termasuk orang lalu-lalang di kejauhan.
   - `customer.csv`: 3–5 orang berdiri bergantian di tempat membayar, ±20 detik masing-masing.
   - `kasir.csv`: hanya kasir bekerja di belakang konter, tanpa customer, 3–5 menit.
3. `npx tsx firmware/sensor-node/tools/calibrate.ts kosong.csv customer.csv kasir.csv` mencetak nilai `#define` yang disarankan dan peringatan (kasir ikut terdeteksi, derau terlalu dekat dengan sinyal, dan sebagainya). Salin ke `app/config.h`.
4. Pasang ulang firmware biasa (`esp32c3`) dan pantau 1–2 minggu dalam **mode shadow** (alert belum dikirim) sebelum mengandalkan R1 dan R3.

## Cara kerja

```
Serial1 (256000 baud) → ld2410_feed → det_update → sesi → chain_presence → /outbox.ndjson → POST /v1/events
```

- **Sesi** dimulai setelah ada terus-menerus 2 detik dan berakhir setelah tidak ada 5 detik. Kedipan sinyal lebih pendek tidak memecah kunjungan. Kunjungan > 15 menit dipecah.
- **Antrean di flash (LittleFS):** event ditulis sebelum dikirim dan dihapus hanya setelah server mengakui `ackedSeq`. Posisi rantai (nomor urut dan hash terakhir) dipulihkan setelah mati listrik dari event terakhir di antrean atau berkas `chain.txt`, sehingga tidak ada nomor urut ganda atau hilang. Server idempoten per `(perangkat, seq)`.
- **Waktu:** NTP. Sebelum waktu sinkron, sesi dibuang dan detak tidak dibuat, supaya tidak ada event dengan jam salah. Selisih jam terhadap server diukur tiap pengiriman.
- **Detak** membawa `status` radar: `ok`, `no_radar` (tidak ada frame > 5 detik, kabel lepas), atau `blocked` (target diam berenergi maksimum menempel di antena > 60 detik, sensor ditutup). Status itu belum dipakai aturan di server.
- Bila antrean melebihi 256 KB (offline lama), detak dihentikan; sesi tetap disimpan.

## Pengujian di komputer

```
make -C firmware/sensor-node          # membangun alat uji C (cc)
npx vitest run firmware               # 27+ tes: parser, detektor, rantai, ingest API, kalibrasi
```

## Kompilasi untuk ESP32

`pio run -e esp32c3` (PlatformIO). Kompilasi pertama mengunduh toolchain dan framework Arduino (±2 GB) dan memakan belasan menit; berikutnya sekitar 20 detik.

## Keamanan dan batas

- Perangkat memakai **token perangkat** dan rantai hash. Tanda tangan dengan kunci perangkat (eFuse/HMAC) **belum ada**: siapa pun yang memegang token dan tahu format rantai bisa memalsukan event atas nama sensor. Ini pending yang sama dengan POS.
- **HTTPS:** `SERVER_URL` berawalan `https://` divalidasi terhadap bundel root CA Mozilla yang dibenamkan di firmware (`certs/x509_crt_bundle.bin`, 121 sertifikat, 55 KB): rantai sertifikat, nama domain, dan masa berlaku. Karena itu jam harus sinkron lebih dulu (portal pairing menyinkronkan NTP sebelum menukar kode). Rantai Let's Encrypt (ISRG Root X1) terbukti cocok dengan logika pencarian di perangkat; server yang rantainya berujung pada root lama yang sudah dikeluarkan dari daftar Mozilla (mis. google.com, example.com) akan ditolak. Kunci Caddy ke Let's Encrypt saja (sudah di `deploy/Caddyfile`). Perbarui bundel sesekali: `pip install certifi cryptography && python3 firmware/sensor-node/tools/gen_cert_bundle.py`, lalu unggah ulang. HTTP polos (`http://`) hanya untuk uji di jaringan lokal dan memunculkan peringatan di Serial Monitor. Penyematan sertifikat tertentu (pinning) belum ada.
- Radar mendeteksi keberadaan, bukan identitas. Alert dari sensor adalah indikasi untuk dicek dengan CCTV.
