// Sensor kehadiran customer untuk Anatta POS.
// Alur: radar LD2410 -> pembaca frame -> detektor sesi -> event bertanda rantai hash -> antrean di flash -> POST /v1/events.
#include <Arduino.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <sys/time.h>
#include <vector>

extern "C" {
#include "chain.h"
#include "detector.h"
#include "ld2410.h"
}
#include "config.h"
#include "ota.h"
#include "provision.h"
#include "signer.h"
#include "transport.h"

static const char *OUTBOX = "/outbox.ndjson";
static const char *CHAIN_FILE = "/chain.txt";

static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
static ld2410_parser_t parser;
static detector_t detector;
static chain_t chain;
static DeviceConfig cfg;

static ld2410_frame_t lastFrame;
static bool haveFrame = false;
static bool zoneNow = false;
static uint32_t sessionsToday = 0;
static uint32_t pending = 0;
static size_t outboxBytes = 0;
static bool chainReady = false;
static String lastPost = "-";
static uint32_t lastHeartbeat = 0, lastFlush = 0, lastScreen = 0, lastWifiTry = 0;
static bool rejecting = false;       // server menolak token (401) tanpa jeda sejak rejectSince
static uint32_t rejectSince = 0;
static uint32_t wifiDownSince = 0;   // 0 = tersambung; selain itu waktu mulai putus
static bool portalOpen = false;      // portal ganti WiFi aktif: layar status tidak boleh menimpa OLED
static bool bootPending = true;      // hitungan boot beruntun belum dikosongkan
static uint32_t unsignedPending = 0; // event di antrean yang tidak bertanda tangan (dibuat sebelum kunci ada); kunci baru didaftarkan setelah habis
static uint32_t enrollRetryAt = 0;
static uint32_t lastSigningCheck = 0, lastOtaCheck = 0;
[[noreturn]] static void factoryReset(const char *reason);
static void showLines(const char *l1, const char *l2, const char *l3, const char *l4);
static void tick();

// ---------- waktu ----------

static int64_t wallMs() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
static bool timeSynced() { return wallMs() > 1700000000000LL; }

// ---------- antrean di flash ----------

static bool extractNumber(const String &line, const char *key, uint64_t &out) {
    int i = line.indexOf(key);
    if (i < 0) return false;
    out = strtoull(line.c_str() + i + strlen(key), nullptr, 10);
    return true;
}

static bool extractHash(const String &line, String &out) {
    int i = line.indexOf("\"hash\":\"");
    if (i < 0) return false;
    out = line.substring(i + 8, i + 8 + 64);
    return out.length() == 64;
}

/** Posisi rantai: event terakhir di antrean, atau posisi tersimpan bila antrean kosong. */
static void loadChain() {
    uint32_t seq = 0;
    String hash = CHAIN_GENESIS;
    String lastLine;
    if (LittleFS.exists(OUTBOX)) {
        File f = LittleFS.open(OUTBOX, "r");
        while (f && f.available()) {
            String l = f.readStringUntil('\n');
            if (l.length() > 10) { lastLine = l; pending++; if (l.indexOf("\"sig\":") < 0) unsignedPending++; }
        }
        outboxBytes = f ? f.size() : 0;
        if (f) f.close();
    }
    uint64_t s;
    String h;
    if (lastLine.length() && extractNumber(lastLine, "\"seq\":", s) && extractHash(lastLine, h)) {
        seq = (uint32_t)s;
        hash = h;
    } else if (LittleFS.exists(CHAIN_FILE)) {
        File f = LittleFS.open(CHAIN_FILE, "r");
        String l = f.readStringUntil('\n');
        f.close();
        int sp = l.indexOf(' ');
        if (sp > 0 && l.length() >= sp + 65) { seq = (uint32_t)l.substring(0, sp).toInt(); hash = l.substring(sp + 1, sp + 65); }
    }
    chainReady = chain_init(&chain, cfg.deviceId.c_str(), cfg.outletId.c_str(), seq, hash.c_str()) == 0;
    Serial.printf("rantai: seq=%u, antrean=%u event\n", (unsigned)seq, (unsigned)pending);
}

static void appendEvent(const char *json) {
    File f = LittleFS.open(OUTBOX, "a");
    if (!f) { Serial.println("GAGAL membuka antrean"); return; }
    f.print(json);
    f.print('\n');
    outboxBytes = f.size();
    f.close();
    pending++;
    if (!strstr(json, "\"sig\":")) unsignedPending++;
}

static void saveChainPosition() {
    File f = LittleFS.open(CHAIN_FILE, "w");
    if (!f) return;
    f.printf("%u %s\n", (unsigned)chain.seq, chain.prev_hash);
    f.close();
}

/** Membuang event yang sudah diakui server (seq <= acked). Bila antrean kosong, posisi rantai disimpan ke file. */
static void ackUpTo(uint64_t acked) {
    std::vector<String> keep;
    File f = LittleFS.open(OUTBOX, "r");
    while (f && f.available()) {
        String l = f.readStringUntil('\n');
        uint64_t s;
        if (l.length() > 10 && extractNumber(l, "\"seq\":", s) && s > acked) keep.push_back(l);
    }
    if (f) f.close();
    if (keep.empty()) {
        saveChainPosition();
        LittleFS.remove(OUTBOX);
        outboxBytes = 0;
    } else {
        File w = LittleFS.open("/outbox.tmp", "w");
        for (auto &l : keep) { w.print(l); w.print('\n'); }
        outboxBytes = w.size();
        w.close();
        LittleFS.remove(OUTBOX);
        LittleFS.rename("/outbox.tmp", OUTBOX);
    }
    pending = keep.size();
    unsignedPending = 0;
    for (auto &l : keep) if (l.indexOf("\"sig\":") < 0) unsignedPending++;
}

// ---------- tanda tangan dan pembaruan ----------

static void applySigner() {
    if (chainReady && signerHasKey()) chain_set_signer(&chain, signerSignCb, nullptr);
}

/**
 * Kunci perangkat dibuat setelah WiFi menyala (pembangkit acak berkualitas penuh), lalu didaftarkan ke server SETELAH semua event lama
 * (yang belum bertanda tangan) terkirim: server menolak event tak bertanda tangan begitu kunci terdaftar. Event baru selalu bertanda tangan
 * sejak kunci ada, jadi yang menunggu di antrean saat pendaftaran sudah sah.
 */
static void maintainSigning(uint32_t now) {
    if (now - lastSigningCheck < 10000) return;
    lastSigningCheck = now;
    if (WiFi.status() != WL_CONNECTED || !timeSynced()) return;
    if (!signerHasKey() && signerGenerate()) applySigner();
    if (signerHasKey() && !signerEnrolled() && unsignedPending == 0 && now >= enrollRetryAt) {
        int st = 0;
        if (signerEnroll(cfg.token, st)) {
            Serial.println("kunci perangkat terdaftar di server");
        } else {
            // 409: server sudah memegang kunci lain untuk perangkat ini; owner harus mengatur ulang kunci di dashboard.
            enrollRetryAt = now + (st == 409 ? 600000UL : 60000UL);
            lastPost = st == 409 ? String("KUNCI 409") : String("kunci ") + st;
            Serial.printf("pendaftaran kunci gagal (HTTP %d)\n", st);
        }
    }
}

static void maintainOta(uint32_t now) {
    if (OTA_CHECK_MS == 0 || strlen(OTA_RELEASE_PUBKEY) == 0) return;
    // Pemeriksaan pertama 2 menit setelah menyala (setelah WiFi dan jam siap), lalu tiap OTA_CHECK_MS.
    if (lastOtaCheck == 0) { if (now < 120000UL) return; lastOtaCheck = now; } else if (now - lastOtaCheck < OTA_CHECK_MS) return;
    lastOtaCheck = now;
    if (WiFi.status() != WL_CONNECTED || !timeSynced() || pending > OTA_MAX_PENDING) return;
    OtaResult r = otaCheckAndUpdate(showLines, tick);
    Serial.printf("OTA: %s\n", otaResultName(r));
    if (r == OTA_UPDATED) { delay(500); ESP.restart(); }
}

// ---------- pembuatan event ----------

static void emitHeartbeat() {
    if (!chainReady || !timeSynced() || outboxBytes > OUTBOX_MAX_BYTES) return;
    char line[CHAIN_LINE_MAX];
    int n = chain_heartbeat(&chain, wallMs(), det_health_name(det_health(&detector, millis())), line, sizeof line);
    if (n > 0) appendEvent(line);
}

static void emitSession(const presence_session_t &s) {
    if (!chainReady) return;
    if (!timeSynced()) { Serial.println("sesi dibuang: waktu belum sinkron"); return; }
    // Detektor memakai jam monotonik (millis); event memakai jam dinding. Selisihnya dihitung saat sesi selesai.
    int64_t skew = wallMs() - (int64_t)millis();
    presence_session_t wall = s;
    wall.start_ms += skew;
    wall.end_ms += skew;
    char line[CHAIN_LINE_MAX];
    int n = chain_presence(&chain, wallMs(), &wall, cfg.terminalId.c_str(), line, sizeof line);
    if (n > 0) {
        appendEvent(line);
        sessionsToday++;
        Serial.printf("sesi: %lld s, energi %u/%u\n", (long long)((wall.end_ms - wall.start_ms) / 1000), s.peak_move, s.peak_static);
    }
}

// ---------- pengiriman ----------

static void flushOutbox() {
    if (pending == 0 || WiFi.status() != WL_CONNECTED || !timeSynced()) return;
    String body = "{\"events\":[";
    int count = 0;
    File f = LittleFS.open(OUTBOX, "r");
    while (f && f.available() && count < FLUSH_BATCH) {
        String l = f.readStringUntil('\n');
        if (l.length() < 10) continue;
        if (count++) body += ',';
        body += l;
    }
    if (f) f.close();
    body += "]}";
    if (count == 0) return;

    HTTPClient http;
    http.setTimeout(8000);
    if (!httpBegin(http, String(SERVER_URL) + "/v1/events")) { lastPost = "URL salah"; return; }
    http.addHeader("Authorization", String("Bearer ") + cfg.token);
    http.addHeader("Content-Type", "application/json");
    // Versi yang berjalan, supaya dashboard bisa menunjukkan sensor mana yang belum diperbarui.
    http.addHeader("X-Firmware-Build", String(FW_BUILD));
    http.addHeader("X-Firmware-Version", FW_VERSION);
    int code = http.POST(body);
    String resp = code > 0 ? http.getString() : String();
    http.end();

    if (code == 201 || code == 200) {
        uint64_t acked = 0, serverTime = 0;
        if (extractNumber(resp, "\"ackedSeq\":", acked)) ackUpTo(acked);
        if (extractNumber(resp, "\"serverTime\":", serverTime)) {
            int64_t off = wallMs() - (int64_t)serverTime;
            chain.clock_offset_ms = (off > 2000 || off < -2000) ? off : 0;
        }
        lastPost = "OK " + String(count);
    } else {
        // 401 berarti token dicabut atau salah. Bila terus ditolak selama AUTH_REJECT_RESET_MS, reset pabrik otomatis.
        lastPost = code == 401 ? String("DITOLAK 401") : code > 0 ? String("HTTP ") + code : String("gagal");
        if (code == 400) Serial.println(resp.substring(0, 200));
        if (code == 401) {
            if (!rejecting) { rejecting = true; rejectSince = millis(); }
            if (millis() - rejectSince >= AUTH_REJECT_RESET_MS) factoryReset("TOKEN DICABUT");
        } else if (code > 0) {
            rejecting = false;
        }
        return;
    }
    rejecting = false;
}

// ---------- tampilan ----------

static void showLines(const char *l1, const char *l2, const char *l3, const char *l4) {
    oled.clearBuffer();
    oled.setFont(u8g2_font_6x10_tf);
    const char *lines[4] = {l1, l2, l3, l4};
    for (int i = 0; i < 4; i++) if (lines[i] && lines[i][0]) oled.drawStr(0, 12 + i * 14, lines[i]);
    oled.sendBuffer();
}

/** Hapus identitas dan rantai, lalu restart ke portal setup. */
[[noreturn]] static void factoryReset(const char *reason) {
    showLines("RESET PABRIK", reason, "Menghapus data...", "");
    provisionClear();
    signerReset();
    provisionBootOk();
    delay(1500);
    ESP.restart();
    for (;;) delay(1000);
}

/** Tombol di PIN_RESET_BTN (ke GND) ditahan RESET_HOLD_MS. */
static void checkFactoryReset(uint32_t now) {
    static uint32_t heldSince = 0;
    if (digitalRead(PIN_RESET_BTN) != LOW) { heldSince = 0; return; }
    if (!heldSince) heldSince = now;
    if (now - heldSince < RESET_HOLD_MS) return;
    factoryReset("Tombol ditahan");
}

static void drawScreen() {
    oled.clearBuffer();
    oled.setFont(u8g2_font_6x10_tf);
    char buf[40];
    snprintf(buf, sizeof buf, "WiFi:%s Waktu:%s", WiFi.status() == WL_CONNECTED ? "ok" : "--", timeSynced() ? "ok" : "--");
    oled.drawStr(0, 10, buf);
    snprintf(buf, sizeof buf, "Radar: %s", det_health_name(det_health(&detector, millis())));
    oled.drawStr(0, 22, buf);
    if (haveFrame && zoneNow) snprintf(buf, sizeof buf, "Customer: ADA %ucm", (unsigned)lastFrame.detect_dist_cm);
    else snprintf(buf, sizeof buf, "Customer: tidak ada");
    oled.drawStr(0, 34, buf);
    snprintf(buf, sizeof buf, "Sesi:%u Antre:%u", (unsigned)sessionsToday, (unsigned)pending);
    oled.drawStr(0, 46, buf);
    snprintf(buf, sizeof buf, "Kirim: %s", lastPost.c_str());
    oled.drawStr(0, 58, buf);
    oled.sendBuffer();
}

// ---------- utama ----------

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("Anatta POS sensor");

    oled.begin();
    oled.setFont(u8g2_font_6x10_tf);
    oled.clearBuffer();
    oled.drawStr(0, 12, "Anatta POS sensor");
    oled.drawStr(0, 26, "memulai...");
    oled.sendBuffer();

    pinMode(PIN_RESET_BTN, INPUT_PULLUP);

    if (!LittleFS.begin(true)) Serial.println("LittleFS gagal; antrean tidak tersimpan");

    // Reset dengan cabut-colok daya: RESET_BOOT_COUNT boot beruntun, masing-masing singkat.
    uint8_t boots = provisionBootCount();
    if (boots >= RESET_BOOT_COUNT) factoryReset("Cabut-colok daya");
    if (boots >= 2) {
        char l[24];
        snprintf(l, sizeof l, "Reset daya %u/%u", (unsigned)boots, (unsigned)RESET_BOOT_COUNT);
        showLines(l, "Cabut-colok lagi", "untuk reset pabrik", "");
        delay(700);
    }

    // Belum dipasang: buka portal setup (tidak kembali; berakhir dengan restart setelah pairing berhasil).
    if (!provisionLoad(cfg)) {
        provisionBootOk();
        provisionPortal(showLines);
    }
    if (!serverIsSecure()) Serial.println("PERINGATAN: SERVER_URL memakai HTTP tanpa enkripsi; hanya untuk uji di jaringan lokal.");
    Serial.printf("perangkat %s, outlet %s, terminal %s\n", cfg.deviceId.c_str(), cfg.outletId.c_str(), cfg.terminalId.length() ? cfg.terminalId.c_str() : "-");
    loadChain();
    applySigner();
    Serial.printf("firmware %s (build %d, kanal %s), kunci perangkat: %s\n", FW_VERSION, FW_BUILD, FW_CHANNEL, signerHasKey() ? (signerEnrolled() ? "terdaftar" : "ada, belum terdaftar") : "belum dibuat");

    Serial1.begin(256000, SERIAL_8N1, PIN_RADAR_RX, PIN_RADAR_TX);
    ld2410_init(&parser);
    det_config_t detCfg;
    det_default_config(&detCfg);
    detCfg.zone_min_cm = ZONE_MIN_CM;
    detCfg.zone_max_cm = ZONE_MAX_CM;
    detCfg.move_energy_min = MOVE_ENERGY_MIN;
    detCfg.static_energy_min = STATIC_ENERGY_MIN;
    det_init(&detector, &detCfg, millis());

    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_TX_POWER);
    WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
    configTime(0, 0, "pool.ntp.org", "time.google.com");
}

/** Pekerjaan inti sensor. Juga dipanggil dari portal ganti WiFi agar deteksi dan antrean tetap berjalan. */
static void tick() {
    uint32_t now = millis();
    if (bootPending && now > RESET_BOOT_WINDOW_MS) { provisionBootOk(); bootPending = false; }

    while (Serial1.available()) {
        ld2410_frame_t f;
        if (ld2410_feed(&parser, (uint8_t)Serial1.read(), &f)) {
            lastFrame = f;
            haveFrame = true;
            zoneNow = det_in_zone(&detector.cfg, &f) != 0;
            presence_session_t s;
            if (det_update(&detector, now, &f, &s)) emitSession(s);
#ifdef CAL_CSV
            // ts,status,jarak_gerak,energi_gerak,jarak_diam,energi_diam,di_zona
            Serial.printf("CSV,%lu,%u,%u,%u,%u,%u,%d\n", (unsigned long)now, f.state, f.move_dist_cm, f.move_energy, f.static_dist_cm, f.static_energy, zoneNow);
#endif
        }
    }
    presence_session_t s;
    if (det_update(&detector, now, nullptr, &s)) emitSession(s);

    if (now - lastHeartbeat >= HEARTBEAT_MS) { lastHeartbeat = now; emitHeartbeat(); }
    if (now - lastFlush >= FLUSH_MS) { lastFlush = now; flushOutbox(); }
    checkFactoryReset(now);
}

void loop() {
    tick();
    uint32_t now = millis();

    if (WiFi.status() == WL_CONNECTED) {
        wifiDownSince = 0;
    } else {
        if (!wifiDownSince) wifiDownSince = now ? now : 1;
        if (now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.reconnect(); }
        // WiFi tersimpan tidak terjangkau cukup lama (router diganti, sandi berubah): buka portal ganti WiFi.
        if (now - wifiDownSince >= WIFI_FALLBACK_MS) {
            portalOpen = true;
            provisionWifiPortal(cfg, showLines, tick, WIFI_PORTAL_MAX_MS);
            portalOpen = false;
            wifiDownSince = millis() ? millis() : 1;  // coba lagi setelah WIFI_FALLBACK_MS berikutnya
        }
    }
    maintainSigning(now);
    maintainOta(now);
    if (now - lastScreen >= 500) { lastScreen = now; if (!portalOpen) drawScreen(); }
}
