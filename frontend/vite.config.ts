import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
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
