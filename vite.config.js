import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// GitHub Pages "deploy from a branch" only supports /docs (or root) as
// the publish folder, so build output goes to docs/. Base path matches
// the repo name so asset URLs resolve under https://<user>.github.io/drafteo/.
// Dev server stays at base '/' so localhost works without the prefix.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/drafteo/' : '/',
  build: { outDir: 'docs', emptyOutDir: true },
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
}));
