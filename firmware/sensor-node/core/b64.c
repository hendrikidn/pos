#include "b64.h"
#include <string.h>

static const char STD[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char URL[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static size_t encode(const uint8_t *in, size_t len, char *out, size_t cap, const char *alpha, int pad) {
    size_t need = pad ? ((len + 2) / 3) * 4 : (len * 4 + 2) / 3;
    if (need + 1 > cap) return 0;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < len) v |= in[i + 2];
        out[o++] = alpha[(v >> 18) & 63];
        out[o++] = alpha[(v >> 12) & 63];
        if (i + 1 < len) out[o++] = alpha[(v >> 6) & 63]; else if (pad) out[o++] = '=';
        if (i + 2 < len) out[o++] = alpha[v & 63]; else if (pad) out[o++] = '=';
    }
    out[o] = '\0';
    return o;
}

size_t b64url_encode(const uint8_t *in, size_t len, char *out, size_t cap) { return encode(in, len, out, cap, URL, 0); }
size_t b64std_encode(const uint8_t *in, size_t len, char *out, size_t cap) { return encode(in, len, out, cap, STD, 1); }

static int val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

int b64_decode(const char *in, uint8_t *out, size_t cap) {
    size_t n = strlen(in);
    while (n > 0 && in[n - 1] == '=') n--;
    if (n % 4 == 1) return -1;
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = val(in[i]);
        if (v < 0) return -1;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (o >= cap) return -1;
            out[o++] = (uint8_t)((acc >> bits) & 0xff);
        }
    }
    return (int)o;
}
