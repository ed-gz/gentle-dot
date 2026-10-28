import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { readBuildStamp } from './scripts/build-stamp.mjs';

const buildInfo = readBuildStamp(fileURLToPath(new URL('../../', import.meta.url)),
  fileURLToPath(new URL('./public/personal-art/', import.meta.url)), process.env.CAPRI_SOURCE_SHA ?? '');

export default defineConfig({
  define: { __CAPRI_BUILD_INFO__: JSON.stringify(buildInfo) },
  resolve: { alias: {
    '@gentle-dot/ui': fileURLToPath(new URL('../../packages/ui', import.meta.url)),
    '@gentle-dot/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
  } },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'safari15' },
});
