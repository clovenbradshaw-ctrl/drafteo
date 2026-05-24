import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// GitHub Pages "deploy from a branch" only supports /docs (or root) as
// the publish folder, so build output goes to docs/. Base path matches
// the repo name so asset URLs resolve under https://<user>.github.io/drafteo/.
// Dev server stays at base '/' so localhost works without the prefix.
//
// manualChunks splits matrix-js-sdk + Olm into a `matrix` chunk and the
// rest of node_modules into `vendor`. Content-hashed filenames mean
// these bundles only change (and re-commit) when the libraries
// themselves change — a UI tweak churns just the small `app` chunk.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/drafteo/' : '/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@matrix-org/olm') || id.includes('matrix-js-sdk') || id.includes('matrix-events-sdk') || id.includes('matrix-widget-api')) return 'matrix';
          if (id.includes('node_modules')) return 'vendor';
        },
        entryFileNames: 'assets/app.[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
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
