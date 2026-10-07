#!/usr/bin/env python3
"""
Membuat paket sertifikat CA untuk firmware (HTTPS) dari daftar root CA Mozilla (paket `certifi`).

Format mengikuti pembaca di core arduino-esp32 (libraries/WiFiClientSecure/src/esp_crt_bundle.c):
  2 byte (big-endian)  jumlah sertifikat
  per sertifikat       2 byte panjang nama, 2 byte panjang kunci, nama subjek (DER), kunci publik (SPKI DER)
Entri harus terurut menurut nama subjek (pembaca memakai pencarian biner).

Pemakaian:
  pip install certifi cryptography
  python3 firmware/sensor-node/tools/gen_cert_bundle.py            # menulis certs/x509_crt_bundle.bin
Jalankan ulang sesekali (mis. tiap beberapa bulan) agar daftar root CA tetap mutakhir, lalu unggah ulang firmware.
"""
import struct
import sys
from pathlib import Path

import certifi
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

OUT = Path(__file__).resolve().parent.parent / "certs" / "x509_crt_bundle.bin"


def main() -> int:
    pem = Path(certifi.where()).read_bytes()
    certs = x509.load_pem_x509_certificates(pem)
    entries = {}
    for c in certs:
        name = c.subject.public_bytes()
        key = c.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        entries[name] = key  # nama sama (root bertanda silang) cukup satu: kuncinya yang diverifikasi
    ordered = sorted(entries.items(), key=lambda kv: kv[0])

    out = struct.pack(">H", len(ordered))
    for name, key in ordered:
        out += struct.pack(">HH", len(name), len(key)) + name + key
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(out)
    print(f"{len(ordered)} sertifikat, {len(out)} byte -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
