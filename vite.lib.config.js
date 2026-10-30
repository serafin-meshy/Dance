import { defineConfig } from 'vite';

// Library build: `npm run build:lib` -> dist-lib/meshy-dance.js (ESM, three.js external)
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    lib: { entry: 'src/lib.js', formats: ['es'], fileName: () => 'meshy-dance.js' },
    rollupOptions: { external: ['three', /^three\//] },
  },
});
