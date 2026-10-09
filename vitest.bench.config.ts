import { defineConfig } from 'vitest/config';

/** Uji beban manual (`npm run bench`): tidak ikut suite biasa karena lama dan bergantung pada PostgreSQL asli (`TEST_PG_URL`). */
export default defineConfig({ test: { include: ['apps/api/bench/**/*.bench.ts'], testTimeout: 900_000, hookTimeout: 900_000 } });
