#pragma once
// Salin menjadi secrets.h. File secrets.h tidak masuk repositori.

// Alamat API. Produksi WAJIB https:// (sertifikat divalidasi terhadap bundel root CA di firmware).
// http://IP:3000 hanya untuk uji di jaringan lokal; token dan data terkirim tanpa enkripsi.
// Alamat ini tertanam di firmware; WiFi, token, dan identitas perangkat TIDAK: semuanya diisi lewat pairing
// (portal setup "ANATTA-xxxx" dengan kode dari dashboard, Pengaturan -> Perangkat).
#define SERVER_URL "https://anatta-pos.dolanyu.com"

// Kunci publik rilis firmware (SPKI base64) dari `npx tsx firmware/sensor-node/tools/release.mts keygen <folder>`. Tanpa ini pembaruan OTA nonaktif.
#define OTA_RELEASE_PUBKEY ""

// Pin sertifikat server (opsional, disarankan): `npx tsx firmware/sensor-node/tools/spki_pin.mts anatta-pos.dolanyu.com`. Beberapa pin dipisah koma.
// #define SERVER_PIN_SPKI_SHA256 "<hex sha256 SPKI>,<hex pin cadangan>"

// ---- Mode uji tanpa pairing (opsional) ----
// Hapus tanda komentar untuk melewati portal dan memakai token yang dicetak `npm run demo`. Jangan dipakai di produksi.
// #define WIFI_SSID "nama-wifi-outlet"
// #define WIFI_PASS "kata-sandi-wifi"
// #define DEVICE_ID "sensor-pos1"
// #define DEVICE_TOKEN "dev_..."
// #define OUTLET_ID "senopati"
// #define TERMINAL_ID "pos-1"
