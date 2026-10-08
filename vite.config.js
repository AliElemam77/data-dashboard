import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 4500,
    outDir: 'dist',
  },
  server: {
    port: 3000,
  },
});
