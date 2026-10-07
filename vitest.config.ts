import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'firmware/*/test/**/*.test.ts'],
    // PostgreSQL in-memory (WASM) butuh waktu saat dibuat; beri ruang lebih dari default 5 detik.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
