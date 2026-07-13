import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@centraid/client': fromHere('../../packages/client/src'),
      '@centraid/design-tokens': fromHere('../../packages/design-tokens/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  plugins: [react()],
});
