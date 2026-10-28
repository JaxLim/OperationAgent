import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
await build({ configFile: false, root, base: './', build: {
  outDir: 'dist/renderer', emptyOutDir: true, target: 'es2023', modulePreload: false,
} });
await build({ configFile: false, root, build: {
  outDir: 'dist/preload', emptyOutDir: true, target: 'es2023', minify: false,
  lib: { entry: `${root}/src/preload/index.ts`, formats: ['cjs'], fileName: () => 'index.cjs' },
  rolldownOptions: { external: ['electron'] },
} });
