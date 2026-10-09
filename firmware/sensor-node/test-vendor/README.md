# Pustaka pihak ketiga khusus uji di komputer

`micro-ecc/` adalah [micro-ecc](https://github.com/kmackay/micro-ecc) (Kenneth MacKay, lisensi BSD 2-clause; teks lisensi ada di `micro-ecc/LICENSE.txt`), tidak diubah.
Dipakai HANYA oleh alat uji (`tools/sigtool.c`) sebagai pembuat dan pemeriksa tanda tangan ECDSA P-256 di komputer, supaya format tanda tangan dan
manifest firmware dari kode C inti diuji silang terhadap verifikasi Node.js/API yang sebenarnya. Firmware ESP32 TIDAK memakainya: perangkat memakai
mbedtls bawaan ESP-IDF (`app/signer.cpp`, `app/ota.cpp`).
