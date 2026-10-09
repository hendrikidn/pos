#include "ota.h"

#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <time.h>

extern "C" {
#include "fw.h"
#include "sha256.h"
}
#include "config.h"
#include "signer.h"
#include "transport.h"

static int verifyCb(void *, const uint8_t xy[64], const uint8_t digest[32], const uint8_t sig[64]) { return ecdsaVerify(xy, digest, sig) ? 1 : 0; }

const char *otaResultName(OtaResult r) {
    switch (r) {
        case OTA_DISABLED: return "nonaktif";
        case OTA_NO_UPDATE: return "terbaru";
        case OTA_UPDATED: return "terpasang";
        case OTA_REJECTED: return "ditolak";
        default: return "gagal";
    }
}

/** Jalur unduhan dari manifest hanya boleh /v1/public/firmware/<angka>/download di server ini (bukan alamat lain). */
static bool urlOk(const char *u) {
    static const char P[] = "/v1/public/firmware/";
    static const char S[] = "/download";
    size_t n = strlen(u), p = sizeof P - 1, s = sizeof S - 1;
    if (n < p + 1 + s || strncmp(u, P, p) != 0 || strcmp(u + n - s, S) != 0) return false;
    for (size_t i = p; i < n - s; i++) if (u[i] < '0' || u[i] > '9') return false;
    return true;
}

OtaResult otaCheckAndUpdate(ShowLines show, Background bg) {
    if (strlen(OTA_RELEASE_PUBKEY) == 0) return OTA_DISABLED;
    if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000L) return OTA_FAILED;

    HTTPClient http;
    http.setTimeout(10000);
    String q = String(SERVER_URL) + "/v1/public/firmware/latest?board=" + FW_BOARD + "&channel=" + FW_CHANNEL + "&build=" + String((unsigned long)FW_BUILD);
    if (!httpBegin(http, q)) return OTA_FAILED;
    int code = http.GET();
    String body = code == 200 ? http.getString() : String();
    http.end();
    if (code != 200) { Serial.printf("OTA: manifest HTTP %d\n", code); return OTA_FAILED; }
    if (body.indexOf("\"update\":true") < 0) return OTA_NO_UPDATE;

    fw_manifest_t m;
    if (fw_manifest_parse(body.c_str(), &m) != FW_OK) { Serial.println("OTA: manifest rusak"); return OTA_REJECTED; }
    int should = fw_should_install(&m, FW_BOARD, FW_CHANNEL, FW_BUILD);
    if (should == FW_E_OLD) return OTA_NO_UPDATE;
    if (should != FW_OK) { Serial.printf("OTA: tidak layak (%d)\n", should); return OTA_REJECTED; }
    int sg = fw_verify_signature(&m, OTA_RELEASE_PUBKEY, verifyCb, nullptr);
    if (sg != FW_OK) { Serial.printf("OTA: TANDA TANGAN TIDAK SAH (%d); rilis diabaikan\n", sg); return OTA_REJECTED; }
    if (!urlOk(m.url)) { Serial.println("OTA: jalur unduhan tidak sah"); return OTA_REJECTED; }

    Serial.printf("OTA: %s build %lu tersedia (sekarang %d), mengunduh %lu byte\n", m.version, (unsigned long)m.build, FW_BUILD, (unsigned long)m.size);
    char l2[24];
    snprintf(l2, sizeof l2, "v%s", m.version);
    if (show) show("MEMPERBARUI", "FIRMWARE", l2, "Jangan cabut daya");

    HTTPClient dl;
    dl.setTimeout(15000);
    if (!httpBegin(dl, String(SERVER_URL) + m.url)) return OTA_FAILED;
    int dcode = dl.GET();
    if (dcode != 200 || (uint32_t)dl.getSize() != m.size) {
        Serial.printf("OTA: unduhan HTTP %d, ukuran %d\n", dcode, dl.getSize());
        dl.end();
        return OTA_FAILED;
    }
    if (!Update.begin(m.size)) {
        Serial.printf("OTA: Update.begin gagal (%s)\n", Update.errorString());
        dl.end();
        return OTA_FAILED;
    }

    WiFiClient *stream = dl.getStreamPtr();
    sha256_ctx sha;
    sha256_init(&sha);
    uint8_t buf[1024];
    uint32_t got = 0, lastData = millis();
    int lastPct = -1;
    while (got < m.size) {
        size_t av = stream->available();
        if (!av) {
            if (millis() - lastData > 30000 || !dl.connected()) break;
            delay(2);
            continue;
        }
        size_t n = stream->readBytes(buf, av < sizeof buf ? av : sizeof buf);
        if (n == 0) continue;
        lastData = millis();
        if (got + n > m.size) { got = m.size + 1; break; }  // lebih panjang dari yang dijanjikan manifest
        sha256_update(&sha, buf, n);
        if (Update.write(buf, n) != n) { Serial.printf("OTA: tulis flash gagal (%s)\n", Update.errorString()); got = 0; break; }
        got += (uint32_t)n;
        int pct = (int)((uint64_t)got * 100 / m.size);
        if (pct / 5 != lastPct / 5) {
            lastPct = pct;
            char l3[24];
            snprintf(l3, sizeof l3, "%d%%", pct);
            if (show) show("MEMPERBARUI", "FIRMWARE", l3, "Jangan cabut daya");
        }
        if (bg) bg();
    }
    dl.end();

    uint8_t digest[32];
    sha256_final(&sha, digest);
    int chk = fw_check_download(&m, digest, got);
    if (chk != FW_OK) {
        Serial.printf("OTA: unduhan ditolak (%d); slot tidak diaktifkan\n", chk);
        Update.abort();
        return chk == FW_E_HASH ? OTA_REJECTED : OTA_FAILED;
    }
    if (!Update.end(true) || !Update.isFinished()) {
        Serial.printf("OTA: Update.end gagal (%s)\n", Update.errorString());
        return OTA_FAILED;
    }
    Serial.println("OTA: terpasang; restart");
    return OTA_UPDATED;
}
