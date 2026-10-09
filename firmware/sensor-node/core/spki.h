#ifndef SN_SPKI_H
#define SN_SPKI_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Kunci publik ECDSA P-256 dalam bentuk SPKI DER (yang diminta server di POST /v1/device/key): 26 byte kepala tetap + 0x04 || X || Y. */
#define SPKI_P256_LEN 91

/* xy = X(32) || Y(32), big-endian. */
void spki_p256_build(const uint8_t xy[64], uint8_t out[SPKI_P256_LEN]);
/* Mengambil X||Y dari SPKI P-256 tak terkompresi. Mengembalikan 0 bila bentuknya tepat; -1 bila bukan. */
int spki_p256_parse(const uint8_t *der, size_t len, uint8_t xy[64]);

#ifdef __cplusplus
}
#endif

#endif
