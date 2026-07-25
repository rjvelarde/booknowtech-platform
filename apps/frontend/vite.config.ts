import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { loadPublicEnvironment } from './src/config.js';

export default defineConfig(({ mode }) => {
  const publicEnvironment = loadEnv(mode, '../..', 'VITE_');
  loadPublicEnvironment(
    mode === 'test' && !publicEnvironment.VITE_API_BASE_URL
      ? { VITE_API_BASE_URL: 'http://localhost:3000' }
      : publicEnvironment,
  );

  return {
    envDir: '../..',
    plugins: [react()],
    server: {
      port: 4173,
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
