#pragma once
#include <Arduino.h>
#include <HTTPClient.h>

/** True bila SERVER_URL memakai https://. */
bool serverIsSecure();

/**
 * Membuka HTTPClient ke `url`. https:// divalidasi terhadap bundel root CA di firmware (certs/x509_crt_bundle.bin),
 * termasuk nama host dan masa berlaku sertifikat, jadi jam perangkat harus sudah sinkron (NTP). http:// berjalan tanpa enkripsi
 * dan hanya untuk uji di jaringan lokal.
 */
bool httpBegin(HTTPClient &http, const String &url);

/** Menunggu jam dinding sinkron lewat NTP (maks `timeoutMs`). Mengembalikan true bila sudah sinkron. */
bool waitForTime(uint32_t timeoutMs);
