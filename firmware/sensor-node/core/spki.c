#include "spki.h"
#include <string.h>

/* SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING { 04 || X || Y } } */
static const uint8_t HEAD[26] = {
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
};

void spki_p256_build(const uint8_t xy[64], uint8_t out[SPKI_P256_LEN]) {
    memcpy(out, HEAD, sizeof HEAD);
    out[26] = 0x04;
    memcpy(out + 27, xy, 64);
}

int spki_p256_parse(const uint8_t *der, size_t len, uint8_t xy[64]) {
    if (len != SPKI_P256_LEN || memcmp(der, HEAD, sizeof HEAD) != 0 || der[26] != 0x04) return -1;
    memcpy(xy, der + 27, 64);
    return 0;
}
