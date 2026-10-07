#ifndef SN_CHAIN_H
#define SN_CHAIN_H
#include <stddef.h>
#include <stdint.h>
#include "detector.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Membentuk event bertanda rantai hash yang identik dengan EventChain di @pos/events (TypeScript):
 *   hash = SHA-256(prevHash + canonicalJson(event tanpa hash))
 * canonicalJson = JSON dengan kunci terurut abjad. Karena semua nilai di sini bilangan bulat atau string ASCII
 * sederhana, urutan kunci ditulis langsung (tidak ada pengurutan saat berjalan).
 */

typedef struct {
    char device_id[48];
    char outlet_id[48];
    uint32_t seq;          /* nomor urut event terakhir yang dibuat */
    char prev_hash[65];    /* hash event terakhir */
    int64_t clock_offset_ms;
} chain_t;

#define CHAIN_GENESIS "0000000000000000000000000000000000000000000000000000000000000000"
#define CHAIN_EVENT_MAX 640

/* seq/prev_hash melanjutkan rantai tersimpan; prev_hash NULL dan seq 0 memulai rantai baru. Mengembalikan 0 bila valid. */
int chain_init(chain_t *c, const char *device_id, const char *outlet_id, uint32_t seq, const char *prev_hash);

/* Menulis satu baris JSON event ke out. Mengembalikan panjangnya, atau -1 bila tidak muat/tidak valid (rantai tidak berubah). */
int chain_presence(chain_t *c, int64_t device_time_ms, const presence_session_t *s, const char *terminal_id, char *out, size_t cap);
int chain_heartbeat(chain_t *c, int64_t device_time_ms, const char *status, char *out, size_t cap);

#ifdef __cplusplus
}
#endif

#endif
