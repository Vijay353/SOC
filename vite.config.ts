import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 4300);

export default defineConfig({
  root: 'app',
  plugins: [react()],
  // Only VITE_-prefixed variables can reach the browser bundle. No secret uses that prefix.
  envPrefix: 'VITE_PUBLIC_',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
