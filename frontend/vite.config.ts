import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // The service worker names its cache after this, so a release drops the previous one
  // instead of serving a stale shell (see src/lib/pwa.ts and public/sw.js).
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  optimizeDeps: { exclude: ['@decisionguru/shared'] },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:5178',
        changeOrigin: true,
      },
    },
  },
});
