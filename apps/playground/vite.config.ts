import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const lib = (path: string) => fileURLToPath(new URL(`../../packages/counterpoint/src/${path}`, import.meta.url));

// Served from https://autumntrace.github.io/counterpoint/ in production.
export default defineConfig({
  base: '/counterpoint/',
  resolve: {
    // Use the library's TypeScript sources directly: no build step in between.
    alias: [
      { find: /^@autumntrace\/counterpoint\/baseline$/, replacement: lib('baseline/naive.ts') },
      { find: /^@autumntrace\/counterpoint$/, replacement: lib('index.ts') },
    ],
  },
  build: { target: 'es2022' },
});
