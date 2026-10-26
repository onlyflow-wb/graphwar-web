import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// `vite preview` serves the same security headers as production (vercel.json), so they can be tested locally
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
const headers = Object.fromEntries(vercel.headers[0].headers.map(h => [h.key, h.value]));

export default defineConfig({
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 400 },
  server: { port: 5173 },
  preview: { headers },
  test: { include: ['test/**/*.test.ts'] },
} as import('vite').UserConfig);
