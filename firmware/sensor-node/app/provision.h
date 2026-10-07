#pragma once
#include <Arduino.h>

/** Identitas dan akses perangkat. Disimpan di flash (NVS), bukan di firmware: satu firmware untuk semua sensor. */
struct DeviceConfig {
    String wifiSsid, wifiPass, deviceId, token, outletId, terminalId;
    bool valid() const { return wifiSsid.length() && deviceId.length() && token.length() && outletId.length(); }
};

/** Empat baris teks untuk OLED. */
typedef void (*ShowLines)(const char *l1, const char *l2, const char *l3, const char *l4);

/**
 * Membaca konfigurasi dari NVS. Bila kosong dan secrets.h mendefinisikan DEVICE_TOKEN dan kawan-kawannya (mode uji
 * tanpa pairing), memakai nilai itu. Mengembalikan false bila perangkat belum dipasang.
 */
bool provisionLoad(DeviceConfig &cfg);

/** Reset pabrik: hapus konfigurasi dan antrean/rantai event di flash. Perangkat harus di-pairing ulang. */
void provisionClear();

/**
 * Portal setup: membuat WiFi `POSGUARD-xxxx` (sandi tampil di OLED), teknisi mengisi WiFi outlet dan kode pairing dari HP.
 * Perangkat menukar kode dengan token ke server, menyimpannya, lalu restart. Fungsi ini tidak kembali.
 */
[[noreturn]] void provisionPortal(ShowLines show);

/** Dipanggil berulang selama portal terbuka agar sensor tetap bekerja (radar, antrean, tombol reset). */
typedef void (*Background)();

/**
 * Portal ganti WiFi untuk perangkat yang sudah terpasang: identitas dan token tetap, hanya WiFi yang diganti (tanpa kode
 * pairing). Menyimpan WiFi baru hanya bila berhasil tersambung, lalu restart. Kembali (tanpa restart) bila WiFi lama
 * tersambung lagi sendiri atau setelah `maxMs` berlalu.
 */
void provisionWifiPortal(const DeviceConfig &keep, ShowLines show, Background bg, uint32_t maxMs);

/**
 * Hitungan boot beruntun untuk reset dengan cabut-colok daya. `provisionBootCount()` menambah hitungan dan
 * mengembalikannya (panggil sekali saat boot); `provisionBootOk()` mengembalikannya ke 0 setelah perangkat hidup cukup lama.
 */
uint8_t provisionBootCount();
void provisionBootOk();
