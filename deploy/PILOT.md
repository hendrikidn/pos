# Skenario uji perangkat dan pilot, langkah demi langkah

Untuk menjalankan Anatta POS di outlet nyata untuk pertama kali. Semua yang ada di sini sudah dibangun dan lolos uji dengan data simulasi. Yang **belum pernah dijalankan di perangkat atau outlet sungguhan**: firmware sensor di ESP32 (tanda tangan event, pin sertifikat, OTA), plugin Android (printer, laci, kios, Keystore), notifikasi WhatsApp, `restore.sh`, dan seluruh aturan fraud dengan perilaku manusia nyata. Skenario ini membuktikannya satu per satu.

Rujukan: server [README.md](README.md), sensor [instruksi-setup-sensor-ld2410.md](../instruksi-setup-sensor-ld2410.md) dan [firmware/sensor-node/README.md](../firmware/sensor-node/README.md), Android [apps/pos/ANDROID.md](../apps/pos/ANDROID.md).

## Cara memakai dokumen ini

- Kerjakan **berurutan**: tahap 1 sampai 5. Tiap tahap punya syarat lulus. Jangan lanjut bila ada langkah **WAJIB** yang gagal.
- Tiap langkah punya tiga bagian: **Lakukan**, **Harapan**, **Catat**. Salin tabel di tahap 7 dan isi sambil jalan (tanggal, hasil, foto layar). Hasil tertulis adalah bahan memperbaiki kode.
- Bila hasil berbeda dari Harapan, **jangan diperbaiki sambil jalan**. Catat persis yang terjadi (layar, pesan galat, jam), lanjut ke langkah berikutnya yang tidak bergantung, dan laporkan semuanya sekaligus.

## Ringkasan jadwal

| Tahap | Di mana | Lama | Isi |
|---|---|---|---|
| 1. Server siap | Kantor/rumah | ½ hari | Deploy, cadangan, pulih, peringatan, kapasitas, kunci rilis |
| 2. Uji meja | Kantor/rumah | 1 hari | Tablet, printer, laci, sensor di meja, OTA. Outlet "Uji" |
| 3. Uji di tempat | Outlet, **sebelum buka** | ½ hari | Pemasangan sungguhan, WiFi nyata, kalibrasi sensor |
| 4. Gladi kecurangan | Outlet, sebelum buka | 2 jam | Memicu tiap aturan sengaja agar terbukti terdeteksi |
| 5. Hari pertama buka | Outlet | 1 hari | Pindah ke outlet pilot, mode bayangan, pantau |
| 6. Pilot | Outlet | 4 sampai 8 minggu | Tinjau harian, setel ambang, ukur metrik |
| 7. Lembar hasil | | | Tabel untuk diisi |

Yang perlu disiapkan sebelum mulai:

- 1 VPS dengan domain (lihat deploy/README.md), 1 laptop dengan repo ini dan PlatformIO.
- 1 tablet atau HP Android untuk terminal, 1 printer struk ESC/POS (jaringan atau USB), 1 laci kas yang tersambung ke printer.
- 2 sensor ESP32-C3 + LD2410 (satu untuk meja uji, satu cadangan; yang meja uji dipakai merusak OTA), kabel USB **data**, adaptor 5 V.
- 1 HP kedua untuk membuka portal pairing, dan akun WhatsApp/email owner untuk uji notifikasi.
- Dua orang: **Operator** (menjalankan langkah) dan **Pengamat** (berperan sebagai kasir/customer, mencatat).

---

## Tahap 1. Server siap (kantor, ½ hari)

Syarat lulus: server hidup, bisa dipulihkan dari cadangan, dan memberi peringatan sendiri bila bermasalah.

**1.1 Deploy.** WAJIB.
- Lakukan: ikuti deploy/README.md bagian 0 sampai 6, lalu bagian 7 (buat admin platform dan tenant uji).
- Harapan: `https://<domain>/healthz` dan `/readyz` menjawab 200 dari HP lewat data seluler (bukan WiFi kantor); `deploy/healthcheck.sh` hijau.
- Catat: waktu deploy, versi kode (`git log -1`).

**1.2 Admin dan 2FA.** WAJIB.
- Lakukan: masuk ke konsol admin dengan token, aktifkan 2FA (aplikasi authenticator), keluar, masuk lagi.
- Harapan: masuk kedua meminta kode 6 digit. Kode salah ditolak. Isi `ADMIN_ALLOWED_IPS` di `.env` lalu coba masuk dari data seluler: ditolak.
- Catat: simpan token dan kode pemulihan di pengelola sandi.

**1.3 Cadangan dan uji pulih.** WAJIB.
- Lakukan: sebagai `posguard`, jalankan `deploy/backup.sh`, lalu `deploy/restore-test.sh`.
- Harapan: cadangan terenkripsi tercipta; uji pulih memulihkan ke database bantu dan `verify.sql` lulus (rantai event utuh, isolasi tenant bekerja).
- Catat: ukuran berkas, durasi. Simpan kata sandi enkripsi di pengelola sandi **terpisah dari server**.

**1.4 Latihan pemulihan sungguhan.** WAJIB sebelum pilot.
- Lakukan: di VPS cadangan atau jendela perawatan, jalankan `deploy/restore.sh` dari cadangan 1.3.
- Harapan: aplikasi hidup kembali dengan data yang sama; masuk ke dashboard berhasil.
- Catat: waktu pemulihan total (ini angka RTO Anda yang sebenarnya). Skrip ini belum pernah diuji sebelumnya, jadi bagian ini paling mungkin menemukan masalah.

**1.5 Peringatan operasional.**
- Lakukan: isi `ALERT_WEBHOOK_URL` (Slack/WhatsApp gateway), mulai ulang API. Matikan database sebentar: `docker compose stop db`, tunggu 1 menit, `docker compose start db`.
- Harapan: tepat satu peringatan "database tidak terjangkau", lalu satu "kembali terjangkau". `/readyz` 503 selama mati, 200 setelah pulih.
- Catat: berapa lama sampai peringatan datang.

**1.6 Kapasitas di VPS.**
- Lakukan: `npm run bench` (butuh PostgreSQL; cara di bagian "Kapasitas" README).
- Harapan: satu setoran 20 event di bawah 100 ms; evaluasi penuh di bawah 1 detik. Bila tidak, VPS kurang kuat untuk beberapa outlet sibuk.
- Catat: angka-angkanya, bandingkan dengan tabel di README.

**1.7 Kunci rilis firmware.** WAJIB sebelum menyentuh sensor.
- Lakukan: `npx tsx firmware/sensor-node/tools/release.mts keygen ~/kunci-rilis`. Salin `release-private.pem` ke dua tempat terpisah (pengelola sandi dan media fisik di brankas), lalu **hapus dari laptop kerja**. Pasang kunci publik: `FIRMWARE_RELEASE_PUBKEY` di `deploy/.env`, mulai ulang API; `OTA_RELEASE_PUBKEY` di `firmware/sensor-node/app/secrets.h`.
- Harapan: konsol admin > Firmware terbuka tanpa galat. Kehilangan kunci ini berarti sensor di lapangan tidak bisa lagi di-OTA (harus USB satu per satu), jadi dua salinan itu bukan formalitas.
- Catat: lokasi kedua salinan (jangan tulis kuncinya).

**1.8 Pin sertifikat server.**
- Lakukan: `npx tsx firmware/sensor-node/tools/spki_pin.mts <domain>`. Siapkan **pin cadangan** (kunci TLS baru yang sudah dibuat tapi belum dipakai) dan isi keduanya di `SERVER_PIN_SPKI_SHA256` (dipisah koma). Pastikan perpanjangan sertifikat memakai kunci yang sama (`certbot renew --reuse-key`).
- Harapan: dua hash tercetak. Tanpa pin cadangan, rotasi kunci TLS akan mengunci semua sensor sampai di-flash USB.

---

## Tahap 2. Uji meja (kantor, 1 hari)

Syarat lulus: setiap perangkat bekerja sendiri-sendiri dengan server nyata, sebelum dibawa ke outlet.

Buat satu tenant uji dengan **outlet "Uji"** (konsol admin > Tenant baru). Di outlet ini **matikan mode bayangan** (dashboard > Pengaturan > Outlet > Mode shadow > Nonaktifkan sekarang) supaya notifikasi benar-benar terkirim dan hitungan 14 hari outlet pilot tidak terpicu oleh data uji. Buat 3 staf dengan PIN (kasir "Ani", supervisor "Budi", manager "Citra") dan 5 menu contoh.

### 2A. Terminal Android

**2A.1 Pasang dan hubungkan.** WAJIB.
- Lakukan: bangun APK rilis (HTTPS, ANDROID.md "Membangun"), `adb install -r`. Matikan USB debugging dan opsi pengembang. Dashboard > Pengaturan > Perangkat > Tambah perangkat > Terminal, ambil token; di aplikasi isi alamat API dan token di "Hubungkan terminal".
- Harapan: terminal "online" di dashboard dalam 1 menit.

**2A.2 Kunci perangkat.** WAJIB.
- Lakukan: Pengaturan di aplikasi, lihat status kunci. Buat satu order tunai.
- Harapan: kunci berbasis TEE/StrongBox (bila "perangkat lunak", catat: itu lebih lemah). Tidak ada insiden R24 di dashboard (R24 = integritas data perangkat).

**2A.3 Penjualan dasar.** WAJIB.
- Lakukan: sebagai Ani, buat order dine-in 2 item, bayar tunai pas. Buat order kedua, bayar QRIS (isi kode approval). Buat order ketiga, tambah diskon.
- Harapan: ketiganya muncul di dashboard > Laporan dalam 1 menit dengan total benar; pajak dan service charge sesuai pengaturan outlet; struk tercetak.
- Catat: total di struk vs di laporan (harus sama persis).

**2A.4 Void dengan persetujuan.**
- Lakukan: buat order, void. Aplikasi meminta persetujuan: masukkan PIN Budi (supervisor) bukan PIN Ani.
- Harapan: void berhasil dengan PIN penyetuju (Budi). Coba lagi dengan PIN Ani sendiri sebagai penyetuju: seharusnya ditolak. Catat apa yang sebenarnya terjadi.

**2A.5 Offline.** WAJIB.
- Lakukan: aktifkan mode pesawat, buat 5 order tunai, tunggu 10 menit, matikan mode pesawat.
- Harapan: kasir bisa menyelesaikan semua order saat offline. Setelah tersambung, kelima order muncul di dashboard berurutan, tanpa duplikat, tanpa insiden R24.
- Catat: berapa detik dari tersambung sampai semuanya masuk.

**2A.6 Kios.**
- Lakukan: aktifkan Pengaturan > Perangkat > Mode kios. Tekan Home, Back, dan buka notifikasi.
- Harapan: aplikasi tidak bisa ditinggalkan lewat tombol Home/Back/notifikasi. Catat apa yang terjadi bila ada cara keluar (cara keluar yang sah untuk teknisi belum terdokumentasi dan perlu Anda tentukan).

**2A.7 Postur keamanan (R29).**
- Lakukan: aktifkan USB debugging, buka aplikasi 1 menit, matikan lagi.
- Harapan: insiden R29 ("pengaturan keamanan perangkat kasir tidak aman") muncul dengan alasan USB debugging. Setelah dimatikan, tidak ada insiden baru.

### 2B. Printer dan laci kas

**2B.1 Tes cetak.** WAJIB.
- Lakukan: Pengaturan > Printer, pilih Jaringan (IP printer, port 9100) atau USB, "Tes cetak".
- Harapan: struk uji terbaca, huruf tidak pecah, potong kertas berfungsi.

**2B.2 Cetak struk order.**
- Lakukan: bayar order, cetak. Cetak ulang struk yang sama.
- Harapan: struk lengkap (nama outlet, item, pajak, service, total, metode bayar). Cetak ulang bertanda cetak ulang dan tercatat.

**2B.3 Kertas habis.**
- Lakukan: buka penutup printer (atau habiskan gulungan), coba cetak. Tutup lagi, isi kertas.
- Harapan: aplikasi menampilkan "kertas habis" dan penjualan tetap bisa dilanjutkan. Insiden R5 muncul **hanya bila** kertas habis berkepanjangan (bukan 1 menit). Catat jam: kapan R5 muncul.

**2B.4 Laci kas.**
- Lakukan: bayar tunai, lihat laci. Lalu coba buka laci dari menu tanpa transaksi.
- Harapan: laci terbuka otomatis pada pembayaran tunai. Buka tanpa transaksi meminta persetujuan penyetuju dan tercatat.
- Catat: bila laci tidak terbuka, periksa kabel RJ11 dan perintah pulsa di Pengaturan (laci belum pernah diuji dengan perangkat nyata).

### 2C. Sensor di meja

Baca instruksi-setup-sensor-ld2410.md bagian 6 sampai 9 lebih dulu.

**2C.1 Flash dan pairing.** WAJIB.
- Lakukan: `secrets.h` berisi `SERVER_URL`, `OTA_RELEASE_PUBKEY` (dari 1.7), `SERVER_PIN_SPKI_SHA256` (dari 1.8) **dikosongkan dulu**. `pio run -e esp32c3 -t upload`. Dashboard > Pengaturan > Perangkat > Tambah perangkat > Sensor, buat kode, ikuti portal `ANATTA-xxxx`.
- Harapan: OLED menampilkan TERPASANG, lalu `WiFi:ok Waktu:ok`, `Radar: ok`. Sensor muncul Online di dashboard.
- Catat: bila `Radar: no_radar`, periksa wiring (TX ke GPIO4, RX ke GPIO3, 5 V).

**2C.2 Tanda tangan event (pertama kali di ESP32).** WAJIB.
- Lakukan: berdiri di depan sensor 10 detik lalu menjauh, tunggu 1 menit. Lihat Serial Monitor (`pio device monitor`) dan dashboard.
- Harapan: log menyebut kunci dibuat dan didaftarkan; OLED `Kirim: OK n`; **tidak ada** insiden R24 dengan jenis `MISSING_SIGNATURE` atau `BAD_SIGNATURE`.
- Bila gagal: catat seluruh log serial dari boot. Jangan lanjut 2C.3 sampai ini beres, karena OTA dan pin memakai jalur jaringan yang sama.

**2C.3 Pin sertifikat benar.**
- Lakukan: isi `SERVER_PIN_SPKI_SHA256` dengan hash dari 1.8, unggah ulang (identitas tersimpan, tidak perlu pairing ulang).
- Harapan: sensor tetap `Kirim: OK`. Log menyebut pin cocok.

**2C.4 Pin sertifikat salah (uji penolakan).** WAJIB.
- Lakukan: ganti satu karakter hash di `secrets.h`, unggah.
- Harapan: sensor **menolak menyambung** dan tidak mengirim token atau event (periksa di log server: tidak ada permintaan dari sensor itu). OLED menampilkan galat. Kembalikan hash benar, unggah lagi.

**2C.5 Reset kunci.**
- Lakukan: flash ulang penuh (hapus flash: `pio run -e esp32c3 -t erase` lalu unggah), pairing ulang dengan kode baru.
- Harapan: server menjawab 409 (sudah ada kunci lain), OLED `Kirim: KUNCI 409`. Dashboard > Pengaturan > Perangkat: reset kunci sensor itu. Dalam ±10 menit sensor mendaftar ulang dan `Kirim: OK` kembali.

**2C.6 OTA, jalur normal di kanal beta.** WAJIB.
- Lakukan: naikkan `FW_BUILD` di `app/config.h`, ubah juga `FW_VERSION`. Bangun dengan `-DFW_CHANNEL=\"beta\"` untuk sensor meja. Tanda tangani dan terbitkan: `release.mts sign ... --channel beta`, lalu `release.mts publish ...` (README sensor, bagian OTA). Sensor yang diuji di-flash ulang USB ke build lama lebih dulu.
- Harapan: dalam 6 jam (atau setelah restart, saat konfigurasi awal) sensor mengunduh, memasang, restart, dan melapor versi baru. Dashboard > daftar perangkat menunjukkan versi baru.
- Catat: berapa lama dari terbit sampai terpasang, dan ukuran firmware.

**2C.7 OTA, jalur yang harus gagal.** WAJIB.
- Lakukan, satu per satu:
  1. Terbitkan build yang **sama atau lebih kecil** dari yang berjalan.
  2. Terbitkan berkas dengan tanda tangan dari kunci lain (`keygen` ke folder sementara).
  3. Cabut listrik sensor di tengah unduhan (lihat log: sedang mengunduh).
- Harapan: (1) tidak dipasang (anti-downgrade); (2) server menolak unggahan, atau bila lolos, sensor menolaknya; (3) setelah listrik kembali sensor boot ke firmware lama yang utuh.
- Bila (3) macet (tidak boot): tidak ada rollback otomatis di Arduino-ESP32. Pulihkan lewat USB. **Ini alasan OTA ke stable tidak boleh dilakukan sebelum 2C.6 dan 2C.7 lulus di beta.**

**2C.8 Penolakan token.**
- Lakukan: dashboard > Pengaturan > Perangkat > Cabut sensor. Lihat OLED.
- Harapan: `Kirim: DITOLAK 401` dalam 1 menit. Reset pabrik (tahan BOOT 10 detik), pairing ulang dengan kode baru.

### 2D. Notifikasi

**2D.1 Insiden kritis sampai ke owner.** WAJIB.
- Lakukan: di outlet "Uji" (bayangan mati), buat kondisi kritis dengan sengaja (ikuti 4.x di bawah, mis. refund tanpa customer), tunggu.
- Harapan: pesan WhatsApp/email owner tiba dalam 1 sampai 2 menit, berisi ringkasan insiden dan tautan, tanpa data pelanggan sensitif.
- Catat: jam kejadian vs jam pesan tiba. Bila WhatsApp tidak tiba, periksa konfigurasi gateway (belum pernah diuji dengan layanan nyata).

**2D.2 Gateway mati.**
- Lakukan: matikan gateway/ubah kredensialnya jadi salah, picu satu insiden lagi.
- Harapan: kegagalan terlihat di log (`docker compose logs api`) sebagai galat pengiriman, tidak mengganggu penjualan, dan tidak diulang tanpa batas.

**Syarat lulus tahap 2:** semua langkah WAJIB lulus. Perbaiki yang gagal sebelum tahap 3.

---

## Tahap 3. Uji di tempat (outlet, sebelum buka, ½ hari)

Syarat lulus: perangkat terpasang di posisi akhir, bekerja di WiFi dan ruangan nyata, dan sensor terkalibrasi.

**3.1 Jaringan.** WAJIB.
- Lakukan: di lokasi kasir, buka `https://<domain>/healthz` dari tablet. Ukur sinyal WiFi di titik tablet, printer, dan sensor.
- Harapan: terbuka tanpa peringatan sertifikat; sinyal cukup di ketiga titik. Sensor butuh WiFi 2,4 GHz dengan akses internet (NTP dan HTTPS).
- Catat: SSID dan frekuensi. Bila WiFi outlet memblokir NTP, sensor tidak bisa menyinkronkan jam.

**3.2 Pasang perangkat.** WAJIB.
- Lakukan: tablet ke dudukan, printer dan laci ke posisi, sensor ke posisi (instruksi bagian 9, "Penempatan": menghadap area berdiri customer, jauh dari kipas/tirai/pintu otomatis, tidak ada logam di depan radar). Pairing ulang sensor dan terminal ke outlet **"Uji"** (kode baru; sensor: tahan BOOT 10 detik untuk reset pabrik, lalu pairing). Perangkat baru dipindah ke outlet pilot setelah gladi tahap 4.
- Harapan: terminal dan sensor Online di outlet "Uji" dari lokasi nyata. **Jangan buat order di outlet pilot**: order pertama di sana memulai hitungan mode bayangan.
- Catat: foto posisi sensor dari depan dan samping (untuk perbandingan kalau kalibrasi bergeser).

**3.3 Kalibrasi sensor.** WAJIB.
- Lakukan: instruksi bagian 9 (`esp32c3-calibrate`, tiga rekaman `kosong.csv`, `customer.csv`, `kasir.csv`, lalu `calibrate.ts`). Tulis nilai ke `config.h`, unggah firmware biasa.
- Harapan: skrip menyarankan ambang yang memisahkan "kosong" dari "customer" dengan jelas. Bila hasil tumpang tindih, ubah posisi sensor lalu ulangi rekaman.
- Catat: nilai ambang dan tanggal; simpan ketiga CSV di repo privat.

**3.4 Verifikasi kalibrasi.**
- Lakukan: Pengamat berdiri di depan kasir (2 detik, 10 detik, 1 menit), lalu kasir berdiri di belakang konter sendirian 5 menit, lalu kosong 2 menit.
- Harapan: OLED menghitung sesi untuk customer, **tidak** untuk kasir sendirian, dan tidak untuk kosong. Satu sesi dimulai setelah 2 detik ada terus-menerus dan berakhir setelah 5 detik tidak ada.

**3.5 Printer dan laci di tempat.**
- Lakukan: ulangi 2B.1 dan 2B.4 di posisi akhir.
- Harapan: sama seperti di meja.

**3.6 Setel staf dan menu nyata.**
- Lakukan: buat staf dengan PIN nyata (kasir tidak boleh berbagi PIN), impor menu CSV (`POST /v1/menu/import`, ada pratinjau), atur pajak (PBJT), service charge, pembulatan, EDC dan TID di Pengaturan > Outlet.
- Harapan: harga di POS cocok dengan buku menu; satu order contoh menghasilkan total yang sama dengan hitungan manual Anda.

**Syarat lulus tahap 3:** 3.2, 3.3, 3.4 selesai dan terdokumentasi.

---

## Tahap 4. Gladi kecurangan (outlet, sebelum buka, 2 jam)

Tujuan: membuktikan bahwa aturan benar-benar mendeteksi, memakai perilaku yang dilakukan sengaja oleh Pengamat. Dilakukan di **outlet "Uji"** (bayangan mati) dengan perangkat sudah di posisi nyata (dari 3.2), agar insiden tampil di Insiden dan notifikasi terkirim.

Untuk tiap skenario: **Lakukan**, tunggu hingga 15 menit (jeda antar-evaluasi, plus jendela waktu aturan), lalu cek dashboard > Insiden. Bila insiden belum muncul setelah 15 menit, itu **temuan** (catat jam), bukan alasan mengulang.

| # | Skenario | Lakukan | Harapan |
|---|---|---|---|
| 4.1 | Customer di kasir tanpa order (R1) | Pengamat berdiri di depan kasir 1 menit, kasir tidak membuat order | Insiden R1 "customer di kasir tanpa order" |
| 4.2 | Void setelah customer pergi (R3) | Buat order, bayar, Pengamat pergi dari depan kasir, kasir void dengan persetujuan | Insiden R3 |
| 4.3 | Refund tanpa customer (R21) | Order dibayar, Pengamat pergi, kasir refund | Insiden R21 |
| 4.4 | Order tanpa kehadiran berulang (R25) | Kasir membuat 3 order tunai berturut-turut tanpa ada customer di depan sensor | Insiden R25 |
| 4.5 | Transaksi oleh staf yang tidak absen (R42) | Staf (bukan owner/manager) membuat order tanpa absen masuk | Insiden R42 |
| 4.6 | Kertas habis berkepanjangan (R5) | Buka penutup printer 15 menit, coba cetak berkali-kali | Insiden R5 |
| 4.7 | Postur perangkat tidak aman (R29) | Aktifkan USB debugging, buka aplikasi | Insiden R29 |
| 4.8 | Void tanpa persetujuan | Coba void dengan PIN kasir sendiri | Ditolak di aplikasi (kontrol, bukan insiden) |
| 4.9 | Mati mendadak (R24) | Cabut baterai tablet saat mencetak, hidupkan, lanjutkan penjualan | Tidak ada R24 palsu; event sebelum dan sesudahnya utuh |

Untuk tiap insiden yang muncul: buka dan periksa bahwa (a) bukti sensor dan POS tertaut, (b) skor dan level wajar, (c) pesan notifikasi terkirim ke owner, (d) tombol tinjau berfungsi (dikonfirmasi / sah / alarm palsu / belum jelas).

**Syarat lulus tahap 4:** minimal 4.1, 4.2, 4.5 terdeteksi. Aturan yang tidak muncul dicatat dan dibawa ke pilot sebagai "belum terbukti"; **jangan** menaikkan atau menurunkan ambang sekarang, tunggu data pilot.

**4.10 Pindah ke outlet pilot.** WAJIB. Dashboard > Pengaturan > Perangkat: cabut perangkat dari outlet "Uji", buat kode pairing baru di **outlet pilot**. Sensor: tahan BOOT 10 detik lalu pairing; terminal: hubungkan ulang dengan token baru. Harapan: keduanya Online di outlet pilot, dan outlet pilot belum punya order (hitungan bayangan belum mulai). Data outlet "Uji" tidak ikut ke produksi.

---

## Tahap 5. Hari pertama buka (outlet pilot)

**5.1 Sebelum buka (30 menit).**
- Lakukan: pastikan mode bayangan outlet pilot **aktif** dan atur 28 hari (Pengaturan > Outlet > Mode shadow > ubah lama). Pastikan terminal dan sensor Online. Pastikan semua staf sudah punya PIN pribadi. Jalankan `deploy/backup.sh` satu kali. Beri tahu kasir bahwa ada sistem pencatatan baru (lihat tahap D di bawah untuk bahasa pemberitahuan).
- Harapan: halaman Ringkasan shadow (`/shadow`) menampilkan "menunggu aktivitas pertama".

**5.2 Saat buka.**
- Lakukan: Operator berada di outlet 4 jam pertama. Catat setiap keluhan kasir (lambat, salah tombol, struk, laci, salah hitung).
- Harapan: tidak ada penjualan yang gagal karena aplikasi. Bila ada, hentikan pilot dan perbaiki (kriteria berhenti di bawah).

**5.3 Setelah tutup (30 menit).**
- Lakukan: cocokkan kas fisik dengan laporan hari itu (dashboard > Laporan). Buka `/shadow`: lihat apakah hitungan hari dimulai dan berapa insiden terekam. Cek `docker compose logs api --since 12h` dan `/metrics` (bila diaktifkan) untuk galat.
- Harapan: selisih kas fisik vs laporan dapat dijelaskan. Catat selisihnya, bahkan bila 0.
- Catat: jumlah order, jumlah insiden bayangan, galat di log.

---

## Tahap 6. Pilot (4 sampai 8 minggu)

Mode bayangan sudah ada: insiden dihitung dan disimpan tetapi **tidak** dikirim; owner meninjaunya di `/shadow`. Dokumen ini hanya menambahkan ritme kerja.

**Ritme harian (10 menit, Owner/pemilik pilot):** buka `/shadow`, tinjau insiden kemarin: tandai dikonfirmasi / sah / alarm palsu / belum jelas. Tanpa penandaan, presisi tidak bisa dihitung.

**Ritme mingguan (30 menit):** lihat metrik di bawah. Cek `deploy/healthcheck.sh`, ruang disk, dan hasil `restore-test.sh` terakhir. Catat keluhan kasir.

| Minggu | Fokus |
|---|---|
| 1 sampai 2 | Operasi normal. Jangan mengubah ambang apa pun. Kumpulkan data. Pastikan sensor Online ≥ 99% jam buka |
| 3 sampai 4 | Stel ambang dari data (terutama R11, R12, R13, R20, R50 dan aturan sensor). Catat tiap perubahan, tanggalnya, dan alasannya. Satu perubahan per minggu supaya efeknya terlihat |
| 5 sampai 8 | Nonaktifkan bayangan di satu outlet; outlet kedua tetap bayangan sebagai pembanding. Insiden mulai dikirim sebagai notifikasi |

### Ukuran keberhasilan (SPEC bagian 12)

| Metrik | Target |
|---|---|
| Presisi insiden Kritis (dikonfirmasi / ditinjau) | ≥ 30% |
| Insiden Kritis per outlet per minggu | ≤ 3 |
| Insiden ditinjau sebelum batas retensi CCTV | ≥ 80% |
| Kecocokan otomatis rekonsiliasi non-tunai | ≥ 95% |
| Uptime sensor saat jam buka | ≥ 99% |
| Rasio void/omzet setelah 8 minggu | Dicatat (bukti nilai, tanpa target) |

Jangan menurunkan target setelah melihat hasil. Bila presisi < 30% setelah penyetelan, aturan paling berisik dimatikan atau diturunkan bobotnya, bukan targetnya.

### Kriteria berhenti

Hentikan pilot dan perbaiki bila: event hilang atau rantai hash putus; kasir tidak bisa menyelesaikan penjualan karena aplikasi; kas fisik vs laporan selisih tak terjelaskan lebih dari 2 hari berturut-turut; alarm kritis lebih dari 10 per outlet per minggu setelah minggu ke-3; sensor macet setelah OTA; kasir mengeluh aplikasi memperlambat pelayanan. Kasir harus selalu bisa menyelesaikan penjualan walau server mati (terminal bekerja offline; diuji di 2A.5).

### OTA ke produksi (selama pilot)

Selalu urutan: simpan ke kanal `beta` → satu sensor uji di meja (bukan di outlet) lulus 2C.6 dan 2C.7 → terbitkan ke `stable` di jam sepi → pantau versi di dashboard sampai semua sensor melapor build baru. Tidak ada rollback otomatis: sensor yang macet harus dipulihkan lewat USB, jadi jangan menerbitkan jelang jam sibuk.

### Setelah pilot

Perbarui ambang bawaan dari data, tabel TER/PTKP/BPJS bila tahun berganti, dan ubah catatan "belum diuji di perangkat" di README sensor/Android menjadi hasil nyata. Jadikan setiap insiden pilot yang tidak terdeteksi atau salah sebagai uji regresi baru.

---

## Data pribadi karyawan (selesaikan sebelum tahap 5)

Pilot memproses data pribadi karyawan. Ini daftar teknis sebagai bahan keputusan Anda dan konsultan hukum, bukan nasihat hukum.

| Data | Di mana disimpan | Catatan |
|---|---|---|
| Foto saat absen | Tabel `attendance_photo`; diakses lewat proxy dashboard, tidak publik | Karyawan harus diberi tahu dan menyetujui tertulis |
| NIK/NPWP, paspor, jabatan | Profil pajak staf | Audit log hanya mencatat 4 digit awal NIK; unduhan XML Coretax tercatat |
| PIN staf | Hash dengan salt | Tidak bisa dibaca kembali |
| Kehadiran sensor | Event kehadiran | Mendeteksi keberadaan, bukan identitas |
| Cadangan database | Terenkripsi | Tentukan berapa lama cadangan lama disimpan |

Yang harus Anda putuskan sendiri: dasar hukum dan pemberitahuan ke karyawan, masa simpan foto absen dan event, prosedur menghapus data karyawan yang berhenti, dan siapa yang boleh mengakses. Aplikasi belum punya penghapusan otomatis atau masa simpan yang bisa diatur untuk foto absen dan event; hanya retensi CCTV yang dapat diatur per outlet.

Teks pemberitahuan yang bisa Anda sesuaikan untuk karyawan: "Mulai [tanggal], kasir memakai sistem pencatatan Anatta POS. Sistem mencatat transaksi, waktu absen (dengan foto), dan sensor yang mendeteksi ada atau tidaknya orang di depan kasir (bukan identitas, tanpa kamera atau suara). Data dipakai untuk mencocokkan kas, mencegah selisih, dan menghitung gaji dan pajak. Hanya pemilik dan manajer yang melihatnya. Hubungi [nama] bila ada pertanyaan."

---

## Tahap 7. Lembar hasil (salin dan isi)

Satu baris per langkah. Status: LULUS / GAGAL / SEBAGIAN / DILEWATI (tulis alasannya).

| Langkah | Tanggal | Status | Yang terjadi (singkat) | Bukti (foto, log, tautan) |
|---|---|---|---|---|
| 1.1 Deploy | | | | |
| 1.2 Admin dan 2FA | | | | |
| 1.3 Cadangan dan uji pulih | | | | |
| 1.4 Latihan pemulihan | | | | |
| 1.5 Peringatan operasional | | | | |
| 1.6 Kapasitas VPS | | | | |
| 1.7 Kunci rilis | | | | |
| 1.8 Pin sertifikat | | | | |
| 2A.1 Pasang terminal | | | | |
| 2A.2 Kunci perangkat | | | | |
| 2A.3 Penjualan dasar | | | | |
| 2A.4 Void dengan persetujuan | | | | |
| 2A.5 Offline | | | | |
| 2A.6 Kios | | | | |
| 2A.7 Postur (R29) | | | | |
| 2B.1 Tes cetak | | | | |
| 2B.2 Cetak struk | | | | |
| 2B.3 Kertas habis | | | | |
| 2B.4 Laci kas | | | | |
| 2C.1 Flash dan pairing | | | | |
| 2C.2 Tanda tangan event | | | | |
| 2C.3 Pin benar | | | | |
| 2C.4 Pin salah | | | | |
| 2C.5 Reset kunci | | | | |
| 2C.6 OTA normal (beta) | | | | |
| 2C.7 OTA gagal-yang-benar | | | | |
| 2C.8 Penolakan token | | | | |
| 2D.1 Notifikasi kritis | | | | |
| 2D.2 Gateway mati | | | | |
| 3.1 Jaringan | | | | |
| 3.2 Pasang perangkat | | | | |
| 3.3 Kalibrasi | | | | |
| 3.4 Verifikasi kalibrasi | | | | |
| 3.5 Printer dan laci di tempat | | | | |
| 3.6 Staf dan menu nyata | | | | |
| 4.1 R1 | | | | |
| 4.2 R3 | | | | |
| 4.3 R21 | | | | |
| 4.4 R25 | | | | |
| 4.5 R42 | | | | |
| 4.6 R5 | | | | |
| 4.7 R29 | | | | |
| 4.8 Void tanpa persetujuan | | | | |
| 4.9 Mati mendadak | | | | |
| 4.10 Pindah ke outlet pilot | | | | |
| 5.3 Hari pertama: selisih kas | | | | |

Metrik mingguan pilot:

| Minggu | Order | Insiden bayangan | Kritis | Ditinjau | Dikonfirmasi | Presisi kritis | Uptime sensor | Keluhan kasir |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
