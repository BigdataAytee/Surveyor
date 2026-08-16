import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @ts-expect-error — a plain .mjs build plugin, deliberately not compiled.
import { serviceWorker } from './scripts/sw-plugin.mjs';

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    rollupOptions: {
      /*
       * Two entries, two pages, one build.
       *
       * The admin console is its own HTML document with its own bundle, so it
       * shares no runtime with the app: no shell, no project state, no design
       * system, no service worker. Shared code between two surfaces with
       * opposite jobs is how they slowly become one surface that suits
       * neither — and beyond that, the console must never be something a
       * surveyor's build can accidentally route to.
       */
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
});
