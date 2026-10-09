#include "signer.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_system.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>

extern "C" {
#include "b64.h"
#include "sha256.h"
#include "spki.h"
}
#include "config.h"
#include "transport.h"

static Preferences prefs;
static bool keyLoaded = false;
static uint8_t priv[32];

static int hwRandom(void *, unsigned char *out, size_t len) {
    esp_fill_random(out, len);
    return 0;
}

static bool loadKey() {
    if (keyLoaded) return true;
    if (!prefs.begin("sig", true)) return false;
    size_t n = prefs.getBytesLength("d");
    bool ok = n == sizeof priv && prefs.getBytes("d", priv, sizeof priv) == sizeof priv;
    prefs.end();
    keyLoaded = ok;
    return ok;
}

bool signerHasKey() { return loadKey(); }

bool signerGenerate() {
    if (loadKey()) return true;
    mbedtls_ecp_group grp;
    mbedtls_mpi d;
    mbedtls_ecp_point Q;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_ecp_point_init(&Q);
    bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
              mbedtls_ecp_gen_keypair(&grp, &d, &Q, hwRandom, nullptr) == 0 &&
              mbedtls_mpi_write_binary(&d, priv, sizeof priv) == 0;
    mbedtls_ecp_point_free(&Q);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_group_free(&grp);
    if (!ok) { memset(priv, 0, sizeof priv); return false; }
    if (!prefs.begin("sig", false)) return false;
    prefs.putBytes("d", priv, sizeof priv);
    prefs.putBool("enr", false);
    prefs.end();
    keyLoaded = true;
    Serial.println("kunci perangkat dibuat");
    return true;
}

void signerReset() {
    if (prefs.begin("sig", false)) { prefs.clear(); prefs.end(); }
    memset(priv, 0, sizeof priv);
    keyLoaded = false;
}

/** Kunci publik titik tak terkompresi (65 byte) dari kunci privat. */
static bool publicPoint(uint8_t out65[65]) {
    if (!loadKey()) return false;
    mbedtls_ecp_group grp;
    mbedtls_mpi d;
    mbedtls_ecp_point Q;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_ecp_point_init(&Q);
    size_t olen = 0;
    bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
              mbedtls_mpi_read_binary(&d, priv, sizeof priv) == 0 &&
              mbedtls_ecp_mul(&grp, &Q, &d, &grp.G, hwRandom, nullptr) == 0 &&
              mbedtls_ecp_point_write_binary(&grp, &Q, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, out65, 65) == 0 && olen == 65;
    mbedtls_ecp_point_free(&Q);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_group_free(&grp);
    return ok;
}

bool signerPublicKeyB64(String &out) {
    uint8_t pt[65], der[SPKI_P256_LEN];
    char b64[160];
    if (!publicPoint(pt) || pt[0] != 0x04) return false;
    spki_p256_build(pt + 1, der);
    if (!b64std_encode(der, sizeof der, b64, sizeof b64)) return false;
    out = b64;
    return true;
}

int signerSignCb(void *, const char *hashHex, char *sig, size_t cap) {
    if (!loadKey()) return -1;
    sha256_ctx c;
    uint8_t digest[32], raw[64];
    sha256_init(&c);
    sha256_update(&c, hashHex, strlen(hashHex));
    sha256_final(&c, digest);

    mbedtls_ecp_group grp;
    mbedtls_mpi d, r, s;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&s);
    bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
              mbedtls_mpi_read_binary(&d, priv, sizeof priv) == 0 &&
              mbedtls_ecdsa_sign(&grp, &r, &s, &d, digest, sizeof digest, hwRandom, nullptr) == 0 &&
              mbedtls_mpi_write_binary(&r, raw, 32) == 0 && mbedtls_mpi_write_binary(&s, raw + 32, 32) == 0;
    mbedtls_mpi_free(&s);
    mbedtls_mpi_free(&r);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_group_free(&grp);
    if (!ok) return -1;
    return b64url_encode(raw, sizeof raw, sig, cap) ? 0 : -1;
}

bool signerEnrolled() {
    if (!prefs.begin("sig", true)) return false;
    bool v = prefs.getBool("enr", false);
    prefs.end();
    return v;
}

bool signerEnroll(const String &token, int &status) {
    String pub;
    if (!signerPublicKeyB64(pub)) { status = 0; return false; }
    HTTPClient http;
    http.setTimeout(10000);
    if (!httpBegin(http, String(SERVER_URL) + "/v1/device/key")) { status = 0; return false; }
    http.addHeader("Authorization", String("Bearer ") + token);
    http.addHeader("Content-Type", "application/json");
    status = http.POST(String("{\"publicKey\":\"") + pub + "\"}");
    http.end();
    if (status == 200 || status == 201) {
        if (prefs.begin("sig", false)) { prefs.putBool("enr", true); prefs.end(); }
        return true;
    }
    return false;
}

bool ecdsaVerify(const uint8_t pubXY[64], const uint8_t digest[32], const uint8_t sig[64]) {
    mbedtls_ecp_group grp;
    mbedtls_ecp_point Q;
    mbedtls_mpi r, s;
    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&Q);
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&s);
    uint8_t pt[65];
    pt[0] = 0x04;
    memcpy(pt + 1, pubXY, 64);
    bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
              mbedtls_ecp_point_read_binary(&grp, &Q, pt, sizeof pt) == 0 &&
              mbedtls_ecp_check_pubkey(&grp, &Q) == 0 &&
              mbedtls_mpi_read_binary(&r, sig, 32) == 0 && mbedtls_mpi_read_binary(&s, sig + 32, 32) == 0 &&
              mbedtls_ecdsa_verify(&grp, digest, 32, &Q, &r, &s) == 0;
    mbedtls_mpi_free(&s);
    mbedtls_mpi_free(&r);
    mbedtls_ecp_point_free(&Q);
    mbedtls_ecp_group_free(&grp);
    return ok;
}
