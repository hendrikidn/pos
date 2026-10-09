#pragma once
#include <Arduino.h>
#include "provision.h"

enum OtaResult {
    OTA_DISABLED,     // kunci rilis belum diisi di firmware
    OTA_NO_UPDATE,    // sudah yang terbaru (atau server tidak menawarkan apa pun)
    OTA_UPDATED,      // terpasang; pemanggil harus restart
    OTA_REJECTED,     // manifest/berkas ditolak pemeriksaan keamanan (tanda tangan, hash, anti-downgrade, ukuran)
    OTA_FAILED        // jaringan, server, atau flash bermasalah (aman diulang nanti)
};

/**
 * Memeriksa dan memasang pembaruan firmware. Syarat: WiFi tersambung dan jam sinkron (TLS). Alur:
 *  1. GET /v1/public/firmware/latest?board=&channel=&build= dan baca manifest.
 *  2. Tolak bila build tidak lebih baru (anti-downgrade), papan/kanal berbeda, atau ukuran di luar slot.
 *  3. Verifikasi tanda tangan manifest dengan OTA_RELEASE_PUBKEY (kunci rilis tertanam). Server yang dibobol tidak bisa memasang firmware sendiri.
 *  4. Unduh ke slot OTA yang tidak aktif sambil menghitung SHA-256; berkas hanya dijadikan bootable bila hash dan ukuran cocok manifest bertanda tangan.
 * Slot yang sedang berjalan tidak disentuh sampai pemasangan selesai. `bg` dipanggil di sela unduhan agar deteksi tetap berjalan.
 */
OtaResult otaCheckAndUpdate(ShowLines show, Background bg);
const char *otaResultName(OtaResult r);
