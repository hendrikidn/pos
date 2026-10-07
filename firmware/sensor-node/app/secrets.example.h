#pragma once
// Salin menjadi secrets.h. File secrets.h tidak masuk repositori.

// Alamat API. Produksi WAJIB https:// (sertifikat divalidasi terhadap bundel root CA di firmware).
// http://IP:3000 hanya untuk uji di jaringan lokal; token dan data terkirim tanpa enkripsi.
// Alamat ini tertanam di firmware; WiFi, token, dan identitas perangkat TIDAK: semuanya diisi lewat pairing
// (portal setup "POSGUARD-xxxx" dengan kode dari dashboard, Pengaturan -> Perangkat).
#define SERVER_URL "https://pos.dolanyu.com"

// ---- Mode uji tanpa pairing (opsional) ----
// Hapus tanda komentar untuk melewati portal dan memakai token yang dicetak `npm run demo`. Jangan dipakai di produksi.
// #define WIFI_SSID "nama-wifi-outlet"
// #define WIFI_PASS "kata-sandi-wifi"
// #define DEVICE_ID "sensor-pos1"
// #define DEVICE_TOKEN "dev_..."
// #define OUTLET_ID "senopati"
// #define TERMINAL_ID "pos-1"
