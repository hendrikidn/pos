#ifndef SN_FW_H
#define SN_FW_H
#include <stddef.h>
#include <stdint.h>
#include "sha256.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Pembaruan firmware (OTA). Server mengumumkan rilis lewat manifest JSON datar; rilis ditandatangani di luar server dengan kunci rilis
 * ECDSA P-256 yang kunci publiknya tertanam di firmware. Perangkat hanya memasang berkas bila (1) tanda tangan manifest sah,
 * (2) SHA-256 berkas yang diunduh sama dengan yang tertulis di manifest, dan (3) nomor build lebih besar dari yang sedang berjalan.
 * Pesan yang ditandatangani (kanonis):  anatta-fw1|<board>|<channel>|<versi>|<build>|<ukuran>|<sha256 hex>
 * Tanda tangan = ECDSA SHA-256 atas pesan itu, r||s (64 byte) base64url.
 */

#define FW_BOARD_MAX 24
#define FW_CHANNEL_MAX 16
#define FW_VERSION_MAX 24
#define FW_URL_MAX 128
#define FW_MIN_SIZE 65536UL
#define FW_MAX_SIZE 0x1E0000UL  /* 1,875 MB: batas wajar satu slot aplikasi */

typedef struct {
    char board[FW_BOARD_MAX];
    char channel[FW_CHANNEL_MAX];
    char version[FW_VERSION_MAX];
    uint32_t build;
    uint32_t size;
    char sha256[65];
    char sig[100];
    char url[FW_URL_MAX];
} fw_manifest_t;

enum {
    FW_OK = 0,
    FW_E_FORMAT = -1,    /* JSON tidak sah atau ada kolom wajib yang hilang/tidak wajar */
    FW_E_SIG = -2,       /* tanda tangan salah */
    FW_E_BOARD = -3,     /* rilis untuk papan atau kanal lain */
    FW_E_OLD = -4,       /* build tidak lebih baru (anti-downgrade) */
    FW_E_SIZE = -5,      /* ukuran di luar batas */
    FW_E_HASH = -6,      /* SHA-256 berkas tidak cocok */
    FW_E_KEY = -7        /* kunci rilis tidak valid */
};

/* Mengurai manifest. Mengembalikan FW_OK atau FW_E_FORMAT. Kolom: board, channel, version, build, size, sha256, signature, url. */
int fw_manifest_parse(const char *json, fw_manifest_t *m);

/* Menulis pesan kanonis ke out. Mengembalikan panjangnya, atau -1 bila cap kurang. */
int fw_canonical(const fw_manifest_t *m, char *out, size_t cap);

/* Pemeriksa tanda tangan (ECDSA P-256): digest = SHA-256 pesan (32 byte), sig = r||s (64 byte), pub = X||Y (64 byte). Mengembalikan 1 bila sah. */
typedef int (*fw_verify_fn)(void *ctx, const uint8_t pub_xy[64], const uint8_t digest[32], const uint8_t sig[64]);

/* Memeriksa tanda tangan manifest dengan kunci publik rilis (SPKI base64). FW_OK, FW_E_SIG, atau FW_E_KEY. */
int fw_verify_signature(const fw_manifest_t *m, const char *release_pubkey_spki_b64, fw_verify_fn fn, void *ctx);

/* Layak dipasang? Papan/kanal sama, build lebih baru, ukuran wajar. FW_OK atau salah satu kode galat. */
int fw_should_install(const fw_manifest_t *m, const char *board, const char *channel, uint32_t current_build);

/* Pengecekan akhir setelah berkas diunduh: sha256 hasil hitung (heksadesimal) sama dengan manifest dan ukuran cocok. */
int fw_check_download(const fw_manifest_t *m, const uint8_t digest[32], uint32_t received);

#ifdef __cplusplus
}
#endif

#endif
