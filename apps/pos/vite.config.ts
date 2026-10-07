import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './': aset memakai jalur relatif sehingga halaman yang sama dapat dimuat dari assets Android (jendela utama dan layar kedua).
export default defineConfig({ base: './', plugins: [react()] });
