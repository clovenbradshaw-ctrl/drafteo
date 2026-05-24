import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events', 'crypto', 'url'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: { port: 5173, strictPort: false },
  optimizeDeps: {
    include: ['matrix-js-sdk', '@matrix-org/olm'],
  },
});
