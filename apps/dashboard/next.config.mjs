/** @type {import('next').NextConfig} */
const nextConfig = {
  // Paket workspace berisi TypeScript mentah; hanya `labels` yang diimpor sehingga kode Node (crypto) tidak ikut ke browser.
  transpilePackages: ['@pos/rules'],
  poweredByHeader: false,
};
export default nextConfig;
