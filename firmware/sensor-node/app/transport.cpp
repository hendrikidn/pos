#include "transport.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "config.h"

// Bundel root CA dibenamkan lewat board_build.embed_files di platformio.ini.
extern const uint8_t caBundleStart[] asm("_binary_certs_x509_crt_bundle_bin_start");

static WiFiClient plainClient;
static WiFiClientSecure secureClient;

bool serverIsSecure() { return strncmp(SERVER_URL, "https://", 8) == 0; }

bool httpBegin(HTTPClient &http, const String &url) {
    http.setReuse(false);  // satu permintaan per koneksi: lebih sederhana dan tidak menyimpan koneksi TLS menggantung
    if (url.startsWith("https://")) {
        secureClient.setCACertBundle(caBundleStart);
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
