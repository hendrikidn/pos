#include "fw.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "b64.h"
#include "spki.h"

/* ---- pembaca JSON datar: "kunci":"teks" atau "kunci":angka ---- */

static const char *find_key(const char *json, const char *key) {
    char pat[40];
    int n = snprintf(pat, sizeof pat, "\"%s\":", key);
    if (n <= 0 || (size_t)n >= sizeof pat) return NULL;
    const char *p = strstr(json, pat);
    if (!p) return NULL;
    p += n;
    while (*p == ' ') p++;
    return p;
}

/* Teks hanya karakter aman (tanpa escape, tanda kutip, atau karakter kontrol) agar tidak ada kejutan saat dipakai di URL/log. */
static int get_str(const char *json, const char *key, char *out, size_t cap) {
    const char *p = find_key(json, key);
    if (!p || *p != '"') return -1;
    p++;
    size_t i = 0;
    while (*p && *p != '"') {
        unsigned char ch = (unsigned char)*p;
        if (ch < 0x20 || ch >= 0x7f || ch == '\\') return -1;
        if (i + 1 >= cap) return -1;
        out[i++] = (char)ch;
        p++;
    }
    if (*p != '"' || i == 0) return -1;
    out[i] = '\0';
    return 0;
}

static int get_u32(const char *json, const char *key, uint32_t *out) {
    const char *p = find_key(json, key);
    if (!p || *p < '0' || *p > '9') return -1;
    char *end = NULL;
    unsigned long long v = strtoull(p, &end, 10);
    if (end == p || v > 0xffffffffULL) return -1;
    *out = (uint32_t)v;
    return 0;
}

static int is_hex64(const char *s) {
    if (strlen(s) != 64) return 0;
    for (int i = 0; i < 64; i++) {
        char ch = s[i];
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return 0;
    }
    return 1;
}

static int is_token(const char *s) {
    for (; *s; s++) {
        char ch = *s;
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.')) return 0;
    }
    return 1;
}

int fw_manifest_parse(const char *json, fw_manifest_t *m) {
    memset(m, 0, sizeof *m);
    if (!json) return FW_E_FORMAT;
    if (get_str(json, "board", m->board, sizeof m->board) || !is_token(m->board)) return FW_E_FORMAT;
    if (get_str(json, "channel", m->channel, sizeof m->channel) || !is_token(m->channel)) return FW_E_FORMAT;
    if (get_str(json, "version", m->version, sizeof m->version) || !is_token(m->version)) return FW_E_FORMAT;
    if (get_u32(json, "build", &m->build) || m->build == 0) return FW_E_FORMAT;
    if (get_u32(json, "size", &m->size)) return FW_E_FORMAT;
    if (get_str(json, "sha256", m->sha256, sizeof m->sha256) || !is_hex64(m->sha256)) return FW_E_FORMAT;
    if (get_str(json, "signature", m->sig, sizeof m->sig)) return FW_E_FORMAT;
    if (get_str(json, "url", m->url, sizeof m->url) || m->url[0] != '/') return FW_E_FORMAT; /* hanya jalur di server ini, bukan alamat lain */
    return FW_OK;
}

int fw_canonical(const fw_manifest_t *m, char *out, size_t cap) {
    int n = snprintf(out, cap, "anatta-fw1|%s|%s|%s|%" PRIu32 "|%" PRIu32 "|%s", m->board, m->channel, m->version, m->build, m->size, m->sha256);
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

int fw_verify_signature(const fw_manifest_t *m, const char *pubkey_b64, fw_verify_fn fn, void *ctx) {
    uint8_t der[SPKI_P256_LEN + 8];
    int dl = pubkey_b64 ? b64_decode(pubkey_b64, der, sizeof der) : -1;
    uint8_t xy[64];
    if (dl < 0 || spki_p256_parse(der, (size_t)dl, xy) != 0) return FW_E_KEY;
    uint8_t sig[72];
    int sl = b64_decode(m->sig, sig, sizeof sig);
    if (sl != 64) return FW_E_SIG;
    char msg[256];
    int n = fw_canonical(m, msg, sizeof msg);
    if (n < 0) return FW_E_FORMAT;
    sha256_ctx c;
    uint8_t digest[32];
    sha256_init(&c);
    sha256_update(&c, msg, (size_t)n);
    sha256_final(&c, digest);
    return fn(ctx, xy, digest, sig) ? FW_OK : FW_E_SIG;
}

int fw_should_install(const fw_manifest_t *m, const char *board, const char *channel, uint32_t current_build) {
    if (strcmp(m->board, board) != 0 || strcmp(m->channel, channel) != 0) return FW_E_BOARD;
    if (m->build <= current_build) return FW_E_OLD;
    if (m->size < FW_MIN_SIZE || m->size > FW_MAX_SIZE) return FW_E_SIZE;
    return FW_OK;
}

int fw_check_download(const fw_manifest_t *m, const uint8_t digest[32], uint32_t received) {
    if (received != m->size) return FW_E_SIZE;
    char hex[65];
    sha256_hex(digest, hex);
    return strcmp(hex, m->sha256) == 0 ? FW_OK : FW_E_HASH;
}
