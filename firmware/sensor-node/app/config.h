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
#define PIN_OLED_SCL 9

// Tombol reset pabrik: tahan RESET_HOLD_MS saat firmware berjalan. Di SuperMini tombol BOOT ada di GPIO9, yang juga dipakai
// SCL OLED di atas: menekannya mengganggu layar selama ditekan, tidak lebih. Jangan menahan BOOT saat menyalakan
// (itu masuk mode unggah firmware).
#define PIN_RESET_BTN 9
#define RESET_HOLD_MS 10000UL

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
