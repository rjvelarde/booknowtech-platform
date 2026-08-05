import { describe, expect, it } from 'vitest';

import { loadPublicEnvironment } from './config.js';

describe('loadPublicEnvironment', () => {
  it('accepts the explicitly public API origin', () => {
    expect(
      loadPublicEnvironment({
        VITE_API_BASE_URL: '/api',
        VITE_BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
        VITE_BUILD_VERSION: 'a'.repeat(40),
      }),
    ).toEqual({
      VITE_API_BASE_URL: '/api',
      VITE_BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
      VITE_BUILD_VERSION: 'a'.repeat(40),
    });
  });

  it('reports only the invalid variable name', () => {
    expect(() =>
      loadPublicEnvironment({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_BOOKING_ROOT_DOMAIN: 'booknowtech.com',
        VITE_BUILD_VERSION: 'local',
      }),
    ).toThrow('VITE_API_BASE_URL');
    expect(() =>
      loadPublicEnvironment({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_BOOKING_ROOT_DOMAIN: 'booknowtech.com',
        VITE_BUILD_VERSION: 'local',
      }),
    ).not.toThrow(/api\.example/);
  });
});
