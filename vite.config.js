import { defineConfig } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/drafteo/' : '/',
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        view: resolve(__dirname, 'view.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
});
