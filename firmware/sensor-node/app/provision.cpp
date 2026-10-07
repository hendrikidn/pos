// Pairing perangkat: kode sekali pakai dari dashboard ditukar dengan token. Alur dan alasannya ada di README.
#include "provision.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#include "config.h"
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
input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #bbb;border-radius:8px}
button{width:100%;margin-top:18px;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:#1b6ef3;color:#fff}
button:disabled{opacity:.5}.msg{margin-top:16px;padding:12px;border-radius:8px;background:#fff;border:1px solid #ddd}
.err{border-color:#c0392b;color:#c0392b}.ok{border-color:#1e8e3e;color:#1e8e3e}.small{font-size:13px;color:#555}</style></head><body>
<h1>Setup sensor POS Guard</h1>
<p class="small">Perangkat: %MAC%</p>
<form id="f"><label for="ssid">WiFi outlet (2,4 GHz)</label>
<input id="ssid" name="ssid" list="nets" autocomplete="off" autocapitalize="off" required>
<datalist id="nets">%NETS%</datalist>
<label for="pass">Sandi WiFi</label><input id="pass" name="pass" type="password" autocomplete="off">
<label for="code">Kode pairing dari dashboard</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" required>
<button id="go" type="submit">Pasang perangkat</button></form>
<div id="m" class="msg" hidden></div>
<script>
const f=document.getElementById('f'),m=document.getElementById('m'),go=document.getElementById('go');
function show(t,c){m.hidden=false;m.className='msg '+(c||'');m.textContent=t}
async function poll(){
  try{const r=await fetch('/status');const s=await r.json();
    if(s.state==='working'){show(s.msg);setTimeout(poll,1500);return}
    if(s.state==='done'){show(s.msg,'ok');return}
    if(s.state==='failed'){show(s.msg,'err');go.disabled=false;return}
  }catch(e){show('Menunggu perangkat... Bila HP terputus dari WiFi POSGUARD, sambungkan lagi; atau lihat layar OLED dan dashboard.');}
  setTimeout(poll,2000)}
f.addEventListener('submit',async e=>{e.preventDefault();go.disabled=true;show('Mengirim...');
  try{await fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(f))});poll()}
  catch(err){show('Gagal mengirim. Coba lagi.','err');go.disabled=false}});
</script></body></html>)HTML";

enum class JobState { Idle, Pending, Working, Failed, Done };

[[noreturn]] void provisionPortal(ShowLines show) {
    String mac = WiFi.macAddress();
    String suffix = mac.substring(12);
    suffix.replace(":", "");
    String apName = "POSGUARD-" + suffix;
    char apPass[12];
    snprintf(apPass, sizeof apPass, "%08lu", (unsigned long)(esp_random() % 100000000UL));

    // Pindai dulu sebelum AP aktif agar daftar WiFi muncul di formulir.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    String nets;
    int n = WiFi.scanNetworks();
    for (int i = 0; i < n && i < 20; i++) nets += "<option value=\"" + htmlEscape(WiFi.SSID(i)) + "\">";
    WiFi.scanDelete();

    WiFi.mode(WIFI_AP_STA);
    WiFi.setTxPower(WIFI_TX_POWER);
    WiFi.softAP(apName.c_str(), apPass);
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
        web.send(200, "text/html; charset=utf-8", page);
    });
    web.on("/save", HTTP_POST, [&]() {
        if (state == JobState::Pending || state == JobState::Working) { web.send(409, "text/plain", "sedang diproses"); return; }
        jobSsid = web.arg("ssid");
        jobPass = web.arg("pass");
        jobCode = sanitizeCode(web.arg("code"));
        if (!jobSsid.length() || jobCode.length() != 8) {
            state = JobState::Failed;
            message = "Isi nama WiFi dan kode pairing 8 karakter.";
        } else {
            state = JobState::Pending;
            message = "Menyambung ke WiFi...";
        }
        web.send(200, "text/plain", "ok");
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
    if (show) show("SETUP SENSOR", l2, l3, "Buka 192.168.4.1");

    auto serve = [&](uint32_t ms) {
        uint32_t t0 = millis();
        while (millis() - t0 < ms) {
            dns.processNextRequest();
            web.handleClient();
            delay(5);
        }
    };

    for (;;) {
        dns.processNextRequest();
        web.handleClient();
        delay(5);
        if (state != JobState::Pending) continue;

        state = JobState::Working;
        if (show) show("Menyambung WiFi", jobSsid.c_str(), "", "");
        WiFi.begin(jobSsid.c_str(), jobPass.c_str());
        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) serve(200);
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.disconnect(false);
            message = "Gagal tersambung ke WiFi. Periksa nama (harus 2,4 GHz) dan sandinya.";
            state = JobState::Failed;
            if (show) show("WiFi gagal", "Periksa nama/sandi", "", "");
            continue;
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

        message = "Berhasil. Perangkat " + fresh.deviceId + " terpasang dan akan restart.";
        state = JobState::Done;
        if (show) show("TERPASANG", fresh.deviceId.c_str(), "Memulai ulang...", "");
        serve(4000);
        ESP.restart();
    }
}
