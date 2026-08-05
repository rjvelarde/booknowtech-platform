import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { loadPublicEnvironment } from './src/config.js';

export default defineConfig(({ mode }) => {
  const publicEnvironment = loadEnv(mode, '../..', 'VITE_');
  const environment = loadPublicEnvironment(
    mode === 'test' && !publicEnvironment.VITE_API_BASE_URL
      ? {
          VITE_API_BASE_URL: '/api',
          VITE_BOOKING_ROOT_DOMAIN: 'booknowtech.com',
          VITE_BUILD_VERSION: '0'.repeat(40),
        }
      : publicEnvironment,
  );

  return {
    envDir: '../..',
    plugins: [
      react(),
      {
        name: 'booknowtech-build-version',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ version: environment.VITE_BUILD_VERSION }),
          });
        },
      },
    ],
    server: {
      port: 4173,
      proxy: { '/api': 'http://localhost:3000' },
    },
    preview: {
      port: 4173,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
