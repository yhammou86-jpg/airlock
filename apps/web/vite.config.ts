import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@proto': path.resolve(__dirname, '../../packages/protocol/protocol.js'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '../..')] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
