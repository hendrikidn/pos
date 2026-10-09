#pragma once
#include <Arduino.h>

/**
 * Kunci perangkat ECDSA P-256 untuk menandatangani event (mbedtls bawaan ESP-IDF). Kunci privat dibuat DI PERANGKAT setelah WiFi menyala
 * (pembangkit acak perangkat keras berkualitas penuh bila radio aktif), disimpan di NVS, dan tidak pernah dikirim ke mana pun; yang dikirim hanya
 * kunci publik (POST /v1/device/key). Server lalu menolak event sensor ini yang tidak bertanda tangan atau bertanda tangan kunci lain.
 *
 * Batas: tanpa enkripsi flash (eFuse, tidak dapat dibatalkan, tidak diaktifkan di sini) siapa pun yang memegang chip fisik bisa membaca kunci dari
 * flash. Ancaman yang ditutup: pemegang token yang tidak memegang perangkat tidak bisa lagi memalsukan event.
 */

bool signerHasKey();
/** Membuat dan menyimpan kunci bila belum ada. true bila kunci tersedia. Panggil hanya saat WiFi tersambung. */
bool signerGenerate();
/** Menghapus kunci dan status pendaftarannya (reset pabrik atau pairing baru). */
void signerReset();
/** Kunci publik SPKI DER dalam base64 baku (bentuk yang diminta server). */
bool signerPublicKeyB64(String &out);
/** Pemanggil balik untuk chain_set_signer: tanda tangan ES256 r||s base64url atas string hash. */
int signerSignCb(void *ctx, const char *hashHex, char *sig, size_t cap);
bool signerEnrolled();
/** Mendaftarkan kunci publik ke server. true bila terdaftar (juga bila sudah terdaftar dengan kunci yang sama). `status` = kode HTTP (<= 0: jaringan/TLS gagal). */
bool signerEnroll(const String &token, int &status);
/** Verifikasi ECDSA P-256 (untuk tanda tangan rilis firmware): digest 32 byte, sig r||s 64 byte, pub X||Y 64 byte. */
bool ecdsaVerify(const uint8_t pubXY[64], const uint8_t digest[32], const uint8_t sig[64]);
