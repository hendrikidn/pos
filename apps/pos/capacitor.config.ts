import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'id.posguard.pos',
  appName: 'POS Guard',
  webDir: 'dist',
  server: {
    // Asal http://localhost: tetap "secure context" (WebCrypto tersedia) dan dapat memanggil API HTTP di jaringan lokal saat uji.
    // Produksi: gunakan API HTTPS dan hapus cleartext.
    androidScheme: 'http',
    cleartext: true,
  },
  plugins: {
    // fetch lewat tumpukan HTTP native: tanpa CORS dan tanpa blokir konten campuran.
    CapacitorHttp: { enabled: true },
  },
  android: { allowMixedContent: false },
};

export default config;
