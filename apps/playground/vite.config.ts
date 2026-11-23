import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Served from https://autumntrace.github.io/counterpoint/ in production.
export default defineConfig({
  base: '/counterpoint/',
  resolve: {
    alias: {
      // Use the library's TypeScript sources directly: no build step in between.
      '@autumntrace/counterpoint': fileURLToPath(new URL('../../packages/counterpoint/src/index.ts', import.meta.url)),
    },
  },
  build: { target: 'es2022' },
});
