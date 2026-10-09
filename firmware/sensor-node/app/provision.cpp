// Pairing perangkat: kode sekali pakai dari dashboard ditukar dengan token. Alur dan alasannya ada di README.
#include "provision.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#include "config.h"
#include "ota.h"
#include "signer.h"
#include "transport.h"

static const char *NS = "posguard";

// ---------- penyimpanan ----------

bool provisionLoad(DeviceConfig &c) {
    Preferences p;
    if (p.begin(NS, false)) {
        c.wifiSsid = p.getString("ssid", "");
        c.wifiPass = p.getString("pass", "");
        c.deviceId = p.getString("dev", "");
        c.token = p.getString("token", "");
        c.outletId = p.getString("outlet", "");
        c.terminalId = p.getString("term", "");
        p.end();
    }
    if (c.valid()) return true;
#if defined(DEVICE_TOKEN) && defined(DEVICE_ID) && defined(OUTLET_ID) && defined(WIFI_SSID) && defined(WIFI_PASS)
    // Mode uji tanpa pairing: nilai dari secrets.h. Tidak disimpan ke flash.
    c.wifiSsid = WIFI_SSID;
    c.wifiPass = WIFI_PASS;
    c.deviceId = DEVICE_ID;
    c.token = DEVICE_TOKEN;
    c.outletId = OUTLET_ID;
#ifdef TERMINAL_ID
    c.terminalId = TERMINAL_ID;
#endif
    return true;
#else
    return false;
#endif
}

static bool saveConfig(const DeviceConfig &c) {
    Preferences p;
    if (!p.begin(NS, false)) return false;
    bool ok = p.putString("ssid", c.wifiSsid) && p.putString("dev", c.deviceId) && p.putString("token", c.token) &&
              p.putString("outlet", c.outletId);
    p.putString("pass", c.wifiPass);
    p.putString("term", c.terminalId);
    p.end();
    return ok;
}

void provisionClear() {
    Preferences p;
    if (p.begin(NS, false)) {
        p.clear();
        p.end();
    }
    // Rantai event milik identitas lama: perangkat baru harus mulai dari seq 0.
    if (LittleFS.begin(true)) LittleFS.format();
}

// ---------- bantuan ----------

static String htmlEscape(const String &s) {
    String o;
    for (size_t i = 0; i < s.length(); i++) {
        char ch = s[i];
        if (ch == '&') o += "&amp;";
        else if (ch == '<') o += "&lt;";
        else if (ch == '>') o += "&gt;";
        else if (ch == '"') o += "&quot;";
        else if (ch == '\'') o += "&#39;";
        else o += ch;
    }
    return o;
}

/** Nilai string sederhana dari JSON respons API (tanpa escape di dalamnya). Kosong bila tidak ada atau null. */
static String jsonString(const String &body, const char *key) {
    String k = String("\"") + key + "\":\"";
    int i = body.indexOf(k);
    if (i < 0) return "";
    i += k.length();
    int j = body.indexOf('"', i);
    return j < 0 ? String() : body.substring(i, j);
}

static String sanitizeCode(const String &raw) {
    String o;
    for (size_t i = 0; i < raw.length() && o.length() < 16; i++) {
        char ch = raw[i];
        if (isalnum((unsigned char)ch)) o += ch;
    }
    return o;
}

/** Menukar kode dengan token. Mengisi `out` (kecuali WiFi) bila berhasil; `err` berisi pesan untuk teknisi bila gagal. */
static bool enroll(const String &code, DeviceConfig &out, String &err) {
    HTTPClient http;
    http.setTimeout(10000);
    if (!httpBegin(http, String(SERVER_URL) + "/v1/device/enroll")) {
        err = "Alamat server tidak valid.";
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    String body = String("{\"code\":\"") + code + "\",\"hardwareId\":\"" + WiFi.macAddress() + "\"}";
    int status = http.POST(body);
    String resp = status > 0 ? http.getString() : String();
    http.end();

    if (status == 200 || status == 201) {
        out.deviceId = jsonString(resp, "deviceId");
        out.token = jsonString(resp, "token");
        out.outletId = jsonString(resp, "outletId");
        out.terminalId = jsonString(resp, "terminalId");
        if (!out.deviceId.length() || !out.token.length() || !out.outletId.length()) {
            err = "Respons server tidak lengkap.";
            return false;
        }
        return true;
    }
    if (status <= 0) {
        if (serverIsSecure()) {
            // Kegagalan TLS: jam salah (sertifikat dianggap belum/sudah tidak berlaku), domain tidak cocok, atau sertifikat tidak tepercaya.
            err = String("Koneksi aman (HTTPS) ke ") + SERVER_URL + " gagal (kode " + status + "). Penyebab umum: jam belum sinkron, nama domain salah, atau sertifikat server tidak sah. Sensor mendapat IP " +
                  WiFi.localIP().toString() + ", gateway " + WiFi.gatewayIP().toString() + ".";
            return false;
        }
        // IP sensor dan gateway membantu mendiagnosis: bila tidak satu subnet dengan server, jaringannya berbeda.
        err = String("Tidak bisa menghubungi server (") + SERVER_URL + "). Sensor mendapat IP " + WiFi.localIP().toString() +
              ", gateway " + WiFi.gatewayIP().toString() +
              ". Server harus di jaringan WiFi yang sama (tiga angka pertama IP sama) dan WiFi tidak boleh memblokir antar perangkat.";
        return false;
    }
    String msg = jsonString(resp, "message");
    err = msg.length() ? msg : String("Server menolak (HTTP ") + status + ").";
    return false;
}

// ---------- portal ----------

static const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup sensor</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1b1f24}
h1{font-size:20px}label{display:block;margin:14px 0 4px;font-weight:600}
input,select{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #bbb;border-radius:8px}
button{width:100%;margin-top:18px;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:#1b6ef3;color:#fff}
button:disabled{opacity:.5}button.net{background:#fff;color:#1b1f24;border:1px solid #bbb;margin-top:8px;font-weight:400;text-align:left}
.msg{margin-top:16px;padding:12px;border-radius:8px;background:#fff;border:1px solid #ddd}
.err{border-color:#c0392b;color:#c0392b}.ok{border-color:#1e8e3e;color:#1e8e3e}.small{font-size:13px;color:#555}</style></head><body>
<h1>Setup sensor Anatta POS</h1>
<p class="small">Perangkat: %MAC%</p>
<form id="f"><label for="ssid">WiFi outlet (2,4 GHz)</label>
<select id="sel">%NETS%</select>
<input id="ssid" name="ssid" autocomplete="off" autocapitalize="off" placeholder="Nama WiFi" hidden>
<div id="lst" class="small"></div>
<button type="button" id="rs" class="net">Pindai ulang WiFi</button>
<label for="pass">Sandi WiFi</label><input id="pass" name="pass" type="password" autocomplete="off">
%CODEBLOCK%
<button id="go" type="submit">Pasang perangkat</button></form>
<div id="m" class="msg" hidden></div>
<script>
const f=document.getElementById('f'),m=document.getElementById('m'),go=document.getElementById('go');
function show(t,c){m.hidden=false;m.className='msg '+(c||'');m.textContent=t}
const ssid=document.getElementById('ssid'),sel=document.getElementById('sel'),lst=document.getElementById('lst'),rs=document.getElementById('rs');
function add(v,t){const o=document.createElement('option');o.value=v;o.textContent=t;sel.appendChild(o)}
sel.onchange=()=>{if(sel.value==='__manual'){ssid.hidden=false;ssid.value='';ssid.focus()}else{ssid.hidden=true;ssid.value=sel.value}};
function fill(nets){nets=[...new Set(nets)];sel.textContent='';lst.textContent='';
  if(!nets.length){add('__manual','Tidak ada jaringan: ketik manual');sel.value='__manual';sel.onchange();return}
  add('','-- Pilih WiFi ('+nets.length+') --');nets.forEach(n=>add(n,n));add('__manual','Ketik nama WiFi manual...');sel.value='';sel.onchange()}
async function scan(){rs.disabled=true;sel.textContent='';add('','Memindai WiFi...');ssid.hidden=true;ssid.value='';
  try{await fetch('/scan?start=1')}catch(e){}
  for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,1500));
    try{const s=await (await fetch('/scan')).json();if(s.state==='done'){fill(s.nets);rs.disabled=false;return}}catch(e){}}
  fill([]);lst.textContent='Pemindaian gagal. Ketik nama WiFi manual, atau pindai ulang.';rs.disabled=false}
rs.onclick=scan;
const boot=Array.from(sel.options).map(o=>o.value).filter(Boolean);
if(boot.length)fill(boot);else scan();
async function poll(){
  try{const r=await fetch('/status');const s=await r.json();
    if(s.state==='working'){show(s.msg);setTimeout(poll,1500);return}
    if(s.state==='done'){show(s.msg,'ok');return}
    if(s.state==='failed'){show(s.msg,'err');go.disabled=false;return}
  }catch(e){show('Menunggu perangkat... Bila HP terputus dari WiFi ANATTA, sambungkan lagi; atau lihat layar OLED dan dashboard.');}
  setTimeout(poll,2000)}
f.addEventListener('submit',async e=>{e.preventDefault();if(!ssid.value){show('Pilih atau ketik nama WiFi.','err');return}go.disabled=true;show('Mengirim...');
  try{await fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(f))});poll()}
  catch(err){show('Gagal mengirim. Coba lagi.','err');go.disabled=false}});
</script></body></html>)HTML";

static const char CODE_HTML[] PROGMEM = R"HTML(<label for="code">Kode pairing dari dashboard</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" required>)HTML";
static const char KEEP_HTML[] PROGMEM = R"HTML(<p class="small">Perangkat sudah terpasang. Hanya WiFi yang diganti; kode pairing tidak diperlukan.</p>)HTML";

enum class JobState { Idle, Pending, Working, Failed, Done };

uint8_t provisionBootCount() {
    Preferences p;
    if (!p.begin("posboot", false)) return 0;
    uint8_t n = p.getUChar("n", 0) + 1;
    p.putUChar("n", n);
    p.end();
    return n;
}

void provisionBootOk() {
    Preferences p;
    if (!p.begin("posboot", false)) return;
    if (p.getUChar("n", 0)) p.putUChar("n", 0);
    p.end();
}

/**
 * Inti portal. `keep` kosong: pairing awal (tidak kembali; restart setelah berhasil). `keep` terisi: hanya ganti WiFi,
 * kembali bila WiFi lama pulih atau setelah `maxMs` (0 = tanpa batas).
 */
static void runPortal(const DeviceConfig *keep, ShowLines show, Background bg, uint32_t maxMs) {
    String mac = WiFi.macAddress();
    String suffix = mac.substring(12);
    suffix.replace(":", "");
    String apName = "ANATTA-" + suffix;
    char apPass[12];
    // Pairing awal: sandi tetap SETUP_AP_PASS (kode pairing sekali pakai yang mengamankan perangkat). Mode ganti WiFi tidak
    // memakai kode pairing, jadi tetap acak agar orang di sekitar tidak bisa mengganti WiFi sensor.
    if (keep) snprintf(apPass, sizeof apPass, "%08lu", (unsigned long)(esp_random() % 100000000UL));
    else snprintf(apPass, sizeof apPass, "%s", SETUP_AP_PASS);

    // Pindai dulu sebelum AP aktif agar daftar WiFi muncul di formulir.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    String nets;
    // Pindai pertama sering kosong tepat setelah boot: ulangi sampai 3 kali.
    int n = 0;
    for (int attempt = 0; attempt < 3 && n <= 0; attempt++) {
        if (attempt) delay(500);
        n = WiFi.scanNetworks();
    }
    for (int i = 0; i < n && i < 20; i++) nets += "<option value=\"" + htmlEscape(WiFi.SSID(i)) + "\">" + htmlEscape(WiFi.SSID(i)) + "</option>";
    WiFi.scanDelete();

    WiFi.mode(WIFI_AP_STA);
    WiFi.setTxPower(WIFI_TX_POWER);
    WiFi.softAP(apName.c_str(), apPass);
    // Mode ganti WiFi: terus coba WiFi lama di latar; bila pulih, portal ditutup.
    if (keep) WiFi.begin(keep->wifiSsid.c_str(), keep->wifiPass.c_str());
    IPAddress ip = WiFi.softAPIP();

    DNSServer dns;
    dns.start(53, "*", ip);
    WebServer web(80);

    JobState state = JobState::Idle;
    String message;
    String jobSsid, jobPass, jobCode;

    web.on("/", HTTP_GET, [&]() {
        String page = FPSTR(PAGE);
        page.replace("%MAC%", mac);
        page.replace("%NETS%", nets);
        page.replace("%CODEBLOCK%", keep ? FPSTR(KEEP_HTML) : FPSTR(CODE_HTML));
        web.send(200, "text/html; charset=utf-8", page);
    });
    web.on("/save", HTTP_POST, [&]() {
        if (state == JobState::Pending || state == JobState::Working) { web.send(409, "text/plain", "sedang diproses"); return; }
        jobSsid = web.arg("ssid");
        jobPass = web.arg("pass");
        jobCode = sanitizeCode(web.arg("code"));
        if (!jobSsid.length() || (!keep && jobCode.length() != 8)) {
            state = JobState::Failed;
            message = keep ? "Isi nama WiFi." : "Isi nama WiFi dan kode pairing 8 karakter.";
        } else {
            state = JobState::Pending;
            message = "Menyambung ke WiFi...";
        }
        web.send(200, "text/plain", "ok");
    });
    // Pindai ulang atas permintaan formulir: ?start=1 memulai (asinkron), tanpa argumen mengambil hasil.
    // Sementara memindai, AP bisa terputus sebentar; formulir mengulang permintaan sendiri.
    web.on("/scan", HTTP_GET, [&]() {
        if (state == JobState::Pending || state == JobState::Working) { web.send(200, "application/json", "{\"state\":\"busy\"}"); return; }
        int sc = WiFi.scanComplete();
        if (web.hasArg("start")) {
            if (sc != WIFI_SCAN_RUNNING) {
                WiFi.scanDelete();
                WiFi.scanNetworks(true);
            }
            web.send(200, "application/json", "{\"state\":\"scanning\"}");
            return;
        }
        if (sc == WIFI_SCAN_RUNNING) { web.send(200, "application/json", "{\"state\":\"scanning\"}"); return; }
        if (sc < 0) { web.send(200, "application/json", "{\"state\":\"idle\"}"); return; }
        String j = "{\"state\":\"done\",\"nets\":[";
        bool first = true;
        for (int i = 0; i < sc && i < 20; i++) {
            String s = WiFi.SSID(i);
            if (!s.length()) continue;
            s.replace("\\", "\\\\");
            s.replace("\"", "\\\"");
            if (!first) j += ",";
            first = false;
            j += "\"" + s + "\"";
        }
        j += "]}";
        WiFi.scanDelete();
        web.send(200, "application/json", j);
    });
    web.on("/status", HTTP_GET, [&]() {
        const char *s = state == JobState::Done ? "done" : state == JobState::Failed ? "failed" : state == JobState::Idle ? "idle" : "working";
        String j = String("{\"state\":\"") + s + "\",\"msg\":\"" + message + "\"}";
        web.send(200, "application/json", j);
    });
    // Deteksi captive portal (Android/iOS/Windows) meminta alamat acak: arahkan semuanya ke formulir.
    web.onNotFound([&]() {
        web.sendHeader("Location", String("http://") + ip.toString() + "/", true);
        web.send(302, "text/plain", "");
    });
    web.begin();

    Serial.printf("Portal setup: WiFi %s, sandi %s, alamat http://%s\n", apName.c_str(), apPass, ip.toString().c_str());
    char l2[32], l3[32];
    snprintf(l2, sizeof l2, "WiFi: %s", apName.c_str());
    snprintf(l3, sizeof l3, "Sandi: %s", apPass);
    const char *title = keep ? "GANTI WIFI" : "SETUP SENSOR";
    auto showPortal = [&]() { if (show) show(title, l2, l3, "Buka 192.168.4.1"); };
    showPortal();

    auto serve = [&](uint32_t ms) {
        uint32_t t0 = millis();
        while (millis() - t0 < ms) {
            dns.processNextRequest();
            web.handleClient();
            if (bg) bg();
            delay(5);
        }
    };

    uint32_t openedAt = millis();
    uint32_t lastShown = millis();
    for (;;) {
        dns.processNextRequest();
        web.handleClient();
        if (bg) bg();
        delay(5);
        if (state != JobState::Pending) {
            if (keep && state != JobState::Working && state != JobState::Done) {
                // WiFi lama pulih sendiri, atau waktu habis: tutup portal dan kembali bekerja normal.
                bool back = WiFi.status() == WL_CONNECTED;
                bool expired = maxMs && millis() - openedAt >= maxMs;
                if (back || expired) {
                    web.stop();
                    dns.stop();
                    WiFi.softAPdisconnect(true);
                    WiFi.mode(WIFI_STA);
                    WiFi.begin(keep->wifiSsid.c_str(), keep->wifiPass.c_str());
                    return;
                }
            }
            // Layar utama ikut menimpa OLED; tampilkan ulang petunjuk portal secara berkala.
            if (millis() - lastShown > 2000) { lastShown = millis(); showPortal(); }
            continue;
        }

        state = JobState::Working;
        if (show) show("Menyambung WiFi", jobSsid.c_str(), "", "");
        WiFi.begin(jobSsid.c_str(), jobPass.c_str());
        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) serve(200);
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.disconnect(false);
            if (keep) WiFi.begin(keep->wifiSsid.c_str(), keep->wifiPass.c_str());
            message = "Gagal tersambung ke WiFi. Periksa nama (harus 2,4 GHz) dan sandinya.";
            state = JobState::Failed;
            if (show) show("WiFi gagal", "Periksa nama/sandi", "", "");
            continue;
        }

        if (keep) {
            // Hanya ganti WiFi: identitas, token, dan antrean event tetap.
            DeviceConfig updated = *keep;
            updated.wifiSsid = jobSsid;
            updated.wifiPass = jobPass;
            if (!saveConfig(updated)) {
                message = "Gagal menyimpan konfigurasi di flash.";
                state = JobState::Failed;
                continue;
            }
            message = "Berhasil. WiFi diganti ke " + jobSsid + "; sensor akan restart.";
            state = JobState::Done;
            if (show) show("WIFI DIGANTI", jobSsid.c_str(), "Memulai ulang...", "");
            serve(4000);
            ESP.restart();
        }

        // Sertifikat HTTPS divalidasi terhadap tanggal, jadi jam harus sinkron dulu.
        message = "Menyinkronkan jam...";
        if (show) show("Sinkron jam...", "", "", "");
        if (serverIsSecure() && !waitForTime(20000)) {
            WiFi.disconnect(false);
            message = "Jam tidak bisa disinkronkan (NTP tidak terjangkau). WiFi harus punya akses internet.";
            state = JobState::Failed;
            if (show) show("Jam gagal", "WiFi tanpa internet?", "", "");
            continue;
        }

        message = "Menukar kode pairing...";
        if (show) show("Menukar kode...", "", "", "");
        DeviceConfig fresh;
        String err;
        if (!enroll(jobCode, fresh, err)) {
            WiFi.disconnect(false);
            message = err;
            state = JobState::Failed;
            if (show) show("Pairing gagal", "Lihat HP Anda", "", "");
            continue;
        }
        fresh.wifiSsid = jobSsid;
        fresh.wifiPass = jobPass;
        if (!saveConfig(fresh)) {
            message = "Gagal menyimpan konfigurasi di flash.";
            state = JobState::Failed;
            continue;
        }
        // Identitas baru: buang antrean/rantai lama (bila ada) agar mulai dari seq 0.
        if (LittleFS.begin(true)) LittleFS.format();

        // Konfigurasi awal selesai dengan dua hal yang butuh jaringan, selagi WiFi dan jam siap dan belum ada event sama sekali:
        // (1) kunci tanda tangan perangkat dibuat dan didaftarkan, sehingga SETIAP event sensor ini bertanda tangan sejak yang pertama;
        // (2) memeriksa dan memasang firmware yang lebih baru (hanya yang bertanda tangan kunci rilis). Kegagalan salah satunya tidak membatalkan
        // pairing: keduanya diulang sendiri saat berjalan.
        if (show) show("Menyiapkan kunci...", "", "", "");
        signerReset();
        if (signerGenerate()) {
            int keyStatus = 0;
            if (!signerEnroll(fresh.token, keyStatus)) Serial.printf("pendaftaran kunci ditunda (HTTP %d)\n", keyStatus);
        }
        message = "Memeriksa pembaruan firmware...";
        if (show) show("Cek firmware...", "", "", "");
        OtaResult ota = otaCheckAndUpdate(show, nullptr);
        Serial.printf("OTA saat konfigurasi awal: %s\n", otaResultName(ota));
        if (ota == OTA_UPDATED) {
            message = "Berhasil. Perangkat " + fresh.deviceId + " terpasang dan firmware diperbarui; sensor akan restart.";
            state = JobState::Done;
            if (show) show("FIRMWARE BARU", "TERPASANG", "Memulai ulang...", "");
            serve(4000);
            ESP.restart();
        }

        message = "Berhasil. Perangkat " + fresh.deviceId + " terpasang dan akan restart.";
        state = JobState::Done;
        if (show) show("TERPASANG", fresh.deviceId.c_str(), "Memulai ulang...", "");
        serve(4000);
        ESP.restart();
    }
}

[[noreturn]] void provisionPortal(ShowLines show) {
    runPortal(nullptr, show, nullptr, 0);
    for (;;) delay(1000);  // runPortal pairing awal tidak kembali; pagar untuk atribut noreturn
}

void provisionWifiPortal(const DeviceConfig &keep, ShowLines show, Background bg, uint32_t maxMs) {
    runPortal(&keep, show, bg, maxMs);
}
