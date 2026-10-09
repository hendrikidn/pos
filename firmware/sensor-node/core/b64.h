#ifndef SN_B64_H
#define SN_B64_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* base64url tanpa padding (dipakai tanda tangan event). Mengembalikan panjang teks, atau 0 bila cap kurang (cap termasuk NUL). */
size_t b64url_encode(const uint8_t *in, size_t len, char *out, size_t cap);
/* base64 baku dengan padding (dipakai kunci publik SPKI). */
size_t b64std_encode(const uint8_t *in, size_t len, char *out, size_t cap);
/* Menerima alfabet baku atau url, padding opsional. Mengembalikan jumlah byte, atau -1 bila ada karakter tidak sah / cap kurang. */
int b64_decode(const char *in, uint8_t *out, size_t cap);

#ifdef __cplusplus
}
#endif

#endif
