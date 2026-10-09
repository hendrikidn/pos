#pragma once
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// ---- Pin (ESP32-C3 SuperMini) ----
// LD2410: TX radar -> RX ESP, RX radar -> TX ESP, VCC 5V, GND. Pin OUT tidak dipakai (frame UART lebih kaya).
#define PIN_RADAR_RX 4
#define PIN_RADAR_TX 3
// OLED SSD1306 I2C, daya 3,3 V.
#define PIN_OLED_SDA 8
#define PIN_OLED_SCL 5

// Tombol reset pabrik: tombol BOOT bawaan SuperMini (GPIO9), tahan RESET_HOLD_MS saat firmware berjalan. SCL OLED sengaja
// dipindah ke GPIO5 supaya GPIO9 tidak ikut naik-turun oleh bus I2C. Jangan menahan BOOT saat menyalakan (itu masuk mode
// unggah firmware).
#define PIN_RESET_BTN 9
#define RESET_HOLD_MS 10000UL

// Reset tanpa tombol: cabut-colok daya (atau tekan RESET) RESET_BOOT_COUNT kali beruntun, masing-masing menyala kurang
// dari RESET_BOOT_WINDOW_MS. Hitungan dikosongkan setelah sensor hidup selama RESET_BOOT_WINDOW_MS.
#define RESET_BOOT_COUNT 5
#define RESET_BOOT_WINDOW_MS 6000UL

// Sandi WiFi portal pairing awal (ANATTA-xxxx). Minimal 8 karakter (syarat WPA2).
#define SETUP_AP_PASS "12345678"

// Bila WiFi tersimpan tidak tersambung selama WIFI_FALLBACK_MS, buka portal ganti WiFi (identitas tetap) selama
// WIFI_PORTAL_MAX_MS; tutup sendiri bila WiFi lama pulih.
#define WIFI_FALLBACK_MS (3UL * 60UL * 1000UL)
#define WIFI_PORTAL_MAX_MS (10UL * 60UL * 1000UL)

// Server menolak token (HTTP 401) tanpa jeda selama ini: anggap token dicabut, reset pabrik otomatis ke portal pairing.
#define AUTH_REJECT_RESET_MS (30UL * 60UL * 1000UL)

// ---- Zona customer dan ambang (dikalibrasi di outlet; lihat README) ----
#define ZONE_MIN_CM 30
#define ZONE_MAX_CM 150
#define MOVE_ENERGY_MIN 25
#define STATIC_ENERGY_MIN 30

// ---- Jaringan ----
// Sebagian klon SuperMini memiliki antena Wi-Fi yang tidak stabil pada daya penuh. Turunkan bila sering putus.
#define WIFI_TX_POWER WIFI_POWER_8_5dBm
#define HEARTBEAT_MS 30000UL
#define FLUSH_MS 5000UL
#define FLUSH_BATCH 20
// Bila antrean melebihi ini (offline lama), detak tidak dibuat lagi agar tidak ada nomor urut yang hilang saat penuh.
#define OUTBOX_MAX_BYTES (256UL * 1024UL)

// ---- Identitas firmware dan pembaruan (OTA) ----
// FW_BUILD naik setiap rilis (bilangan bulat); perangkat hanya memasang build yang LEBIH BARU dari ini (anti-downgrade). Harus sama dengan --build
// saat menandatangani rilis (tools/release.mts). FW_VERSION hanya label untuk manusia.
#define FW_BOARD "esp32c3"
#define FW_VERSION "1.1.0"
#define FW_BUILD 2
#ifndef FW_CHANNEL
#define FW_CHANNEL "stable"
#endif
// Pemeriksaan pembaruan berkala saat berjalan (selain saat konfigurasi awal). 0 = hanya saat konfigurasi awal.
#define OTA_CHECK_MS (6UL * 60UL * 60UL * 1000UL)
// Pembaruan hanya dipasang saat antrean event hampir kosong, supaya tidak ada yang menggantung lama saat restart.
#define OTA_MAX_PENDING 10

// Kunci publik rilis ECDSA P-256 (SPKI base64) yang dipercaya firmware; dibuat dengan `tools/release.mts keygen`. Kosong = OTA nonaktif.
// Diisi di secrets.h. Kunci privatnya TIDAK ada di firmware maupun server.
#ifndef OTA_RELEASE_PUBKEY
#define OTA_RELEASE_PUBKEY ""
#endif

// Pin sertifikat server (opsional, sangat disarankan): daftar SHA-256 kunci publik (SPKI) sertifikat server dalam heksadesimal, dipisah koma, maksimal 3
// (yang sekarang + cadangan). Dihitung dengan `tools/spki_pin.mts <host>`. Bila terisi, koneksi HTTPS HANYA diterima jika kunci publik sertifikat daun
// salah satu pin: CA mana pun yang salah menerbitkan sertifikat untuk domain Anda tidak bisa menyadap sensor, dan token tidak pernah terkirim ke
// server yang salah. Kosong = hanya validasi rantai terhadap bundel root CA.
#ifndef SERVER_PIN_SPKI_SHA256
#define SERVER_PIN_SPKI_SHA256 ""
#endif
