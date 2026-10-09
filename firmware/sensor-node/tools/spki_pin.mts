/**
 * Mencetak "pin" SPKI SHA-256 sertifikat server (heksadesimal) untuk SERVER_PIN_SPKI_SHA256 di firmware:
 *   npx tsx firmware/sensor-node/tools/spki_pin.mts anatta-pos.dolanyu.com [port]
 * Pin menempel pada KUNCI PUBLIK sertifikat daun, bukan sertifikatnya, jadi tetap sama saat sertifikat diperpanjang selama kuncinya dipakai ulang
 * (certbot: `--reuse-key`). Pasang juga pin cadangan (kunci baru yang sudah disiapkan) agar rotasi kunci tidak memutus semua sensor.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';

const [host, port = '443'] = process.argv.slice(2);
if (!host) { console.error('pakai: spki_pin <host> [port]'); process.exit(2); }
const s = connect({ host, port: Number(port), servername: host }, () => {
  const cert = s.getPeerCertificate();
  // SPKI DER dari sertifikat mentah: persis yang dihitung firmware (mbedtls_pk_write_pubkey_der). `cert.pubkey` bawaan Node BUKAN SPKI, jadi tidak dipakai.
  const spki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
  const pin = createHash('sha256').update(spki).digest('hex');
  console.log(`${host}: ${cert.subject?.CN ?? '?'} (berlaku sampai ${cert.valid_to}; penerbit ${cert.issuer?.O ?? '?'})`);
  console.log(`SERVER_PIN_SPKI_SHA256 "${pin}"`);
  s.end();
});
s.on('error', (e) => { console.error(e.message); process.exit(1); });
