const prod = process.env.NODE_ENV === 'production';

/**
 * Header keamanan untuk semua halaman. CSP mengizinkan skrip dan gaya inline karena Next menyisipkan skrip hidrasi inline; selebihnya tertutup:
 * hanya asal sendiri, tidak boleh dibingkai (anti-clickjacking), form hanya ke asal sendiri, tanpa objek/plugin. HSTS hanya di produksi
 * (di pengembangan localhost memakai HTTP).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Paket workspace berisi TypeScript mentah; hanya `labels` yang diimpor sehingga kode Node (crypto) tidak ikut ke browser.
  transpilePackages: ['@pos/rules', '@pos/order', '@pos/events'],
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ...(prod ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
      ],
    }];
  },
};
export default nextConfig;
