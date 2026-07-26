import { describe, expect, it } from 'vitest';

import { loadPublicEnvironment } from './config.js';

describe('loadPublicEnvironment', () => {
  it('accepts the explicitly public API origin', () => {
    expect(loadPublicEnvironment({ VITE_API_BASE_URL: '/api' })).toEqual({
      VITE_API_BASE_URL: '/api',
    });
  });

  it('reports only the invalid variable name', () => {
    expect(() => loadPublicEnvironment({ VITE_API_BASE_URL: 'https://api.example.test' })).toThrow(
      'VITE_API_BASE_URL',
    );
    expect(() =>
      loadPublicEnvironment({ VITE_API_BASE_URL: 'https://api.example.test' }),
    ).not.toThrow(/api\.example/);
  });
});
