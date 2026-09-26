import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything (code, textures, star catalogue) is inlined into one HTML file,
// so the game runs from a double-click, a static host, or an Artifact.
export default defineConfig({
  base: './',
  assetsInclude: ['**/*.bin'],
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 10_000,
    reportCompressedSize: false,
  },
});
