# Anatta POS di Android (pembungkus Capacitor)

Aplikasi POS web (`apps/pos`) dibungkus menjadi aplikasi Android. Pembungkus menambah: printer ESC/POS lewat jaringan atau USB, kunci perangkat di Android Keystore, laporan postur keamanan, mode kios, dan layar customer di layar fisik kedua.

## Status

| Bagian | Status |
|---|---|
| Proyek Android (`android/`), APK debug | **Berhasil dibangun** (`./gradlew assembleDebug`) |
| Konversi tanda tangan Keystore (DER → r‖s) | Diuji unit (`DerTest`, 5 tes) |
| Logika ESC/POS (encoder, status kertas), tanda tangan, postur, R29 | Diuji di komputer (TypeScript), termasuk verifikasi tanda tangan oleh server |
| Plugin native (TCP, USB, kios, Keystore, layar kedua) | **Dikompilasi; belum diuji di perangkat atau emulator** kecuali disebut lain di bagian "Hasil uji emulator" |
| Printer USB, layar kedua, StrongBox | Belum diuji di perangkat keras nyata |

## Membangun

Prasyarat: JDK 21, Android SDK (compileSdk 36), Node.

```
npm install
npm run build -w @pos/pos-app          # membangun web ke apps/pos/dist
cd apps/pos && npx cap sync android    # menyalin web ke proyek Android
cd android && ./gradlew assembleDebug  # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest            # tes unit Java
```

Build debug mengizinkan HTTP polos ke API di jaringan lokal (`src/debug/AndroidManifest.xml`). **Build rilis hanya HTTPS**; gunakan API berbasis HTTPS dan tanda tangani APK dengan kunci rilis Anda.

## Memasang di perangkat

1. Aktifkan USB debugging sementara, `adb install -r app-debug.apk`, lalu **matikan lagi USB debugging dan opsi pengembang** (aplikasi melaporkannya sebagai postur tidak aman, aturan R29).
2. Buka aplikasi, isi alamat API dan token terminal di layar "Hubungkan terminal".
3. Pengaturan › Printer: pilih Jaringan (alamat IP dan port 9100 printer) atau USB, lalu "Tes cetak".
4. Pengaturan › Perangkat: aktifkan Mode kios.

## Kunci perangkat dan tanda tangan

Saat pertama tersambung, aplikasi membuat kunci ECDSA P-256 di Android Keystore dan mendaftarkan kunci publiknya ke server. Sejak itu server menolak event yang tidak bertanda tangan sah dari perangkat itu (R24). Kunci tidak dapat diekspor. Layar Pengaturan menunjukkan apakah kunci berbasis perangkat keras (TEE/StrongBox) atau perangkat lunak.

- Mengganti perangkat atau menghapus data aplikasi membuat kunci baru; owner harus mengatur ulang kunci perangkat itu di server (`POST /v1/devices/:id/key/reset`), dan kejadiannya tercatat di audit.
- Pendaftaran pertama berlaku untuk siapa pun yang memegang token perangkat. Lakukan segera saat pemasangan.

## Mode kios

Tombol Mode kios memakai `startLockTask()` (penyematan layar). Tanpa **device owner**, sistem meminta persetujuan sekali dan pengguna masih bisa keluar dengan kombinasi tombol. Untuk kios penuh pada perangkat yang di-factory reset dan belum punya akun:

```
adb shell dpm set-device-owner id.anatta.pos/.AdminReceiver   # belum disediakan; lihat "Belum ada"
```

## Belum ada

- Penerima admin perangkat (`DeviceAdminReceiver`) agar kios penuh dan kunci pengaturan waktu bisa dipaksakan; saat ini hanya penyematan layar dan pelaporan postur.
- Printer bawaan terminal (Sunmi, iMin, dan sejenisnya) memakai SDK pabrikan; yang didukung baru printer eksternal ESC/POS lewat LAN atau USB. Bluetooth belum.
- Mulai otomatis saat perangkat dinyalakan.
- Pembaruan aplikasi terkelola (MDM).
