#include "transport.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include <mbedtls/pk.h>
#include <mbedtls/x509_crt.h>

extern "C" {
#include "sha256.h"
}
#include "config.h"

// Bundel root CA dibenamkan lewat board_build.embed_files di platformio.ini.
extern const uint8_t caBundleStart[] asm("_binary_certs_x509_crt_bundle_bin_start");

static WiFiClient plainClient;
static WiFiClientSecure secureClient;

bool serverIsSecure() { return strncmp(SERVER_URL, "https://", 8) == 0; }

/** Apakah SHA-256 kunci publik (SPKI) sertifikat daun yang baru dipakai server termasuk salah satu pin di SERVER_PIN_SPKI_SHA256? */
static bool leafPinned(WiFiClientSecure &c) {
    const mbedtls_x509_crt *crt = c.getPeerCertificate();
    if (!crt) return false;
    unsigned char buf[512];
    // Menulis SPKI DER di AKHIR buf dan mengembalikan panjangnya.
    int len = mbedtls_pk_write_pubkey_der(const_cast<mbedtls_pk_context *>(&crt->pk), buf, sizeof buf);
    if (len <= 0) return false;
    sha256_ctx h;
    uint8_t digest[32];
    char hex[65];
    sha256_init(&h);
    sha256_update(&h, buf + sizeof buf - len, (size_t)len);
    sha256_final(&h, digest);
    sha256_hex(digest, hex);
    String pins = String(SERVER_PIN_SPKI_SHA256);
    pins.toLowerCase();
    int from = 0;
    while (from <= (int)pins.length()) {
        int comma = pins.indexOf(',', from);
        String pin = pins.substring(from, comma < 0 ? pins.length() : comma);
        pin.trim();
        if (pin.length() == 64 && pin.equals(String(hex))) return true;
        if (comma < 0) break;
        from = comma + 1;
    }
    return false;
}

bool httpBegin(HTTPClient &http, const String &url) {
    http.setReuse(false);  // satu permintaan per koneksi: lebih sederhana dan tidak menyimpan koneksi TLS menggantung
    if (url.startsWith("https://")) {
        secureClient.setCACertBundle(caBundleStart);
        if (strlen(SERVER_PIN_SPKI_SHA256) > 0) {
            // Sambung dan periksa pin SEBELUM ada data (termasuk token) yang dikirim; HTTPClient memakai koneksi yang sudah terbuka ini.
            String rest = url.substring(8);
            int slash = rest.indexOf('/');
            String hostPort = slash < 0 ? rest : rest.substring(0, slash);
            int colon = hostPort.indexOf(':');
            String host = colon < 0 ? hostPort : hostPort.substring(0, colon);
            uint16_t port = colon < 0 ? 443 : (uint16_t)hostPort.substring(colon + 1).toInt();
            secureClient.stop();
            if (!secureClient.connect(host.c_str(), port)) return false;
            if (!leafPinned(secureClient)) {
                Serial.println("PIN SERTIFIKAT TIDAK COCOK: koneksi dibatalkan (server palsu atau sertifikat diganti tanpa pin baru)");
                secureClient.stop();
                return false;
            }
        }
        return http.begin(secureClient, url);
    }
    return http.begin(plainClient, url);
}

bool waitForTime(uint32_t timeoutMs) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    uint32_t t0 = millis();
    while (time(nullptr) < 1700000000L && millis() - t0 < timeoutMs) delay(200);
    return time(nullptr) >= 1700000000L;
}
