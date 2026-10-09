/*
 * Alat uji di komputer untuk tanda tangan dan pembaruan firmware: memakai micro-ecc (khusus uji) untuk membuat/memeriksa ECDSA P-256 dengan
 * format yang sama dengan firmware ESP32 (mbedtls) dan server (Node.js), supaya kode C inti diuji silang terhadap verifikasi sungguhan.
 *
 *   sigtool pub <privhex>                                   -> SPKI base64 kunci publik
 *   sigtool events <privhex> <device> <outlet> <seq> <prev|-> <n> <t0_ms> [terminal]   -> event bertanda tangan + STATE
 *   sigtool verify <spki_b64> <manifest.json>               -> FW_OK atau kode galat (angka)
 *   sigtool install <manifest.json> <board> <channel> <build_sekarang>
 *   sigtool download <manifest.json> <berkas.bin>           -> memeriksa SHA-256 dan ukuran
 *   sigtool b64 <enc|dec|encstd> <teks-hex|teks>            -> uji base64
 *   sigtool signfail                                        -> penanda tangan gagal: event tidak dibuat dan rantai tidak maju
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/b64.h"
#include "../core/chain.h"
#include "../core/fw.h"
#include "../core/sha256.h"
#include "../core/spki.h"
#include "../test-vendor/micro-ecc/uECC.h"

static int rng(uint8_t *dest, unsigned size) {
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return 0;
    size_t n = fread(dest, 1, size, f);
    fclose(f);
    return n == size;
}

static int from_hex(const char *h, uint8_t *out, size_t n) {
    if (strlen(h) != n * 2) return -1;
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        if (sscanf(h + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (uint8_t)v;
    }
    return 0;
}

static int sign_cb(void *ctx, const char *hash_hex, char *sig_b64, size_t cap) {
    sha256_ctx c;
    uint8_t digest[32], sig[64];
    sha256_init(&c);
    sha256_update(&c, hash_hex, strlen(hash_hex));
    sha256_final(&c, digest);
    if (!uECC_sign((const uint8_t *)ctx, digest, 32, sig, uECC_secp256r1())) return -1;
    return b64url_encode(sig, 64, sig_b64, cap) ? 0 : -1;
}

static int fail_cb(void *ctx, const char *hash_hex, char *sig_b64, size_t cap) {
    (void)ctx; (void)hash_hex; (void)sig_b64; (void)cap;
    return -1;
}

static int verify_cb(void *ctx, const uint8_t xy[64], const uint8_t digest[32], const uint8_t sig[64]) {
    (void)ctx;
    return uECC_verify(xy, digest, 32, sig, uECC_secp256r1());
}

static char *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = malloc((size_t)n + 1);
    if (!b || fread(b, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
    fclose(f);
    b[n] = '\0';
    if (len) *len = (size_t)n;
    return b;
}

static int pubkey_b64(const uint8_t priv[32], char *out, size_t cap) {
    uint8_t xy[64], der[SPKI_P256_LEN];
    if (!uECC_compute_public_key(priv, xy, uECC_secp256r1())) return -1;
    spki_p256_build(xy, der);
    return b64std_encode(der, sizeof der, out, cap) ? 0 : -1;
}

int main(int argc, char **argv) {
    uECC_set_rng(rng);
    if (argc < 2) { fprintf(stderr, "pakai: lihat komentar di tools/sigtool.c\n"); return 2; }
    const char *cmd = argv[1];

    if (!strcmp(cmd, "pub") && argc == 3) {
        uint8_t priv[32];
        char b[160];
        if (from_hex(argv[2], priv, 32) || pubkey_b64(priv, b, sizeof b)) return 3;
        puts(b);
        return 0;
    }

    if (!strcmp(cmd, "events") && argc >= 9) {
        uint8_t priv[32];
        if (from_hex(argv[2], priv, 32)) return 3;
        chain_t c;
        if (chain_init(&c, argv[3], argv[4], (uint32_t)strtoul(argv[5], NULL, 10), strcmp(argv[6], "-") ? argv[6] : NULL) != 0) return 3;
        chain_set_signer(&c, sign_cb, priv);
        int n = atoi(argv[7]);
        int64_t t = strtoll(argv[8], NULL, 10);
        const char *terminal = argc > 9 ? argv[9] : NULL;
        char line[CHAIN_LINE_MAX];
        for (int i = 0; i < n; i++) {
            int len;
            if (i % 3 == 2) {
                presence_session_t s = { t - 58000, t, (uint8_t)(40 + i % 50), (uint8_t)(30 + i % 60) };
                len = chain_presence(&c, t, &s, terminal, line, sizeof line);
            } else {
                len = chain_heartbeat(&c, t, "ok", line, sizeof line);
            }
            if (len < 0) return 4;
            puts(line);
            t += 30000;
        }
        printf("STATE %" PRIu32 " %s\n", c.seq, c.prev_hash);
        return 0;
    }

    if (!strcmp(cmd, "signfail")) {
        chain_t c;
        char line[CHAIN_LINE_MAX];
        if (chain_init(&c, "sensor-x", "o1", 5, NULL) != 0) return 3;
        chain_set_signer(&c, fail_cb, NULL);
        int len = chain_heartbeat(&c, 1000, "ok", line, sizeof line);
        printf("%d %" PRIu32 " %s\n", len, c.seq, c.prev_hash);
        return 0;
    }

    if (!strcmp(cmd, "verify") && argc == 4) {
        char *json = slurp(argv[3], NULL);
        fw_manifest_t m;
        if (!json) return 3;
        int r = fw_manifest_parse(json, &m);
        free(json);
        if (r != FW_OK) { printf("%d\n", r); return 0; }
        printf("%d\n", fw_verify_signature(&m, argv[2], verify_cb, NULL));
        return 0;
    }

    if (!strcmp(cmd, "install") && argc == 6) {
        char *json = slurp(argv[2], NULL);
        fw_manifest_t m;
        if (!json) return 3;
        int r = fw_manifest_parse(json, &m);
        free(json);
        if (r != FW_OK) { printf("%d\n", r); return 0; }
        printf("%d\n", fw_should_install(&m, argv[3], argv[4], (uint32_t)strtoul(argv[5], NULL, 10)));
        return 0;
    }

    if (!strcmp(cmd, "download") && argc == 4) {
        char *json = slurp(argv[2], NULL);
        size_t len = 0;
        char *bin = slurp(argv[3], &len);
        fw_manifest_t m;
        if (!json || !bin) return 3;
        int r = fw_manifest_parse(json, &m);
        free(json);
        if (r != FW_OK) { printf("%d\n", r); return 0; }
        sha256_ctx c;
        uint8_t d[32];
        sha256_init(&c);
        /* disuap bertahap seperti unduhan di perangkat */
        for (size_t off = 0; off < len; off += 1460) sha256_update(&c, bin + off, len - off < 1460 ? len - off : 1460);
        sha256_final(&c, d);
        free(bin);
        printf("%d\n", fw_check_download(&m, d, (uint32_t)len));
        return 0;
    }

    if (!strcmp(cmd, "b64") && argc == 4) {
        uint8_t buf[512];
        char out[1024];
        if (!strcmp(argv[2], "dec")) {
            int n = b64_decode(argv[3], buf, sizeof buf);
            if (n < 0) { puts("ERR"); return 0; }
            for (int i = 0; i < n; i++) printf("%02x", buf[i]);
            puts("");
            return 0;
        }
        size_t hl = strlen(argv[3]);
        if (hl % 2 || hl / 2 > sizeof buf) return 3;
        for (size_t i = 0; i < hl / 2; i++) { unsigned v; sscanf(argv[3] + 2 * i, "%2x", &v); buf[i] = (uint8_t)v; }
        size_t n = !strcmp(argv[2], "enc") ? b64url_encode(buf, hl / 2, out, sizeof out) : b64std_encode(buf, hl / 2, out, sizeof out);
        puts(n || hl == 0 ? out : "ERR");
        return 0;
    }
    return 2;
}
