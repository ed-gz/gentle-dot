import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: {
    '@gentle-dot/ui': fileURLToPath(new URL('../../packages/ui', import.meta.url)),
    '@gentle-dot/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
  } },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'safari15' },
});
