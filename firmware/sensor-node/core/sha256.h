#ifndef SN_SHA256_H
#define SN_SHA256_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t h[8];
    uint8_t buf[64];
    uint64_t total;
    size_t fill;
} sha256_ctx;

void sha256_init(sha256_ctx *c);
void sha256_update(sha256_ctx *c, const void *data, size_t len);
void sha256_final(sha256_ctx *c, uint8_t out[32]);
/* Menulis 64 karakter hex + NUL ke out (65 byte). */
void sha256_hex(const uint8_t in32[32], char out[65]);

#ifdef __cplusplus
}
#endif

#endif
