import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @ts-expect-error — a plain .mjs build plugin, deliberately not compiled.
import { serviceWorker } from './scripts/sw-plugin.mjs';

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { host: '127.0.0.1', port: 5173 },
});
