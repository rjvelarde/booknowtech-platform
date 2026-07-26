import { describe, expect, it } from 'vitest';

import { loadEnvironment } from './config.js';

const valid = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://user:password@localhost:27017',
  MONGODB_DATABASE: 'booknowtech_test',
  BUILD_VERSION: 'commit-abc123',
  ADMIN_ORIGIN: 'https://admin.example.test',
  TENANT_ADMIN_ENABLED: 'false',
  OPENAPI_ENABLED: 'true',
};

describe('loadEnvironment', () => {
  it('loads a valid typed environment', () => {
    expect(loadEnvironment(valid)).toMatchObject({ PORT: 3000, OPENAPI_ENABLED: true });
  });

  it.each(Object.keys(valid))('rejects a missing %s without echoing values', (name) => {
    const source = { ...valid };
    delete source[name as keyof typeof source];

    expect(() => loadEnvironment(source)).toThrow(name);
    expect(() => loadEnvironment(source)).not.toThrow(/password/);
  });

  it('disables OpenAPI in production', () => {
    expect(() => loadEnvironment({ ...valid, NODE_ENV: 'production' })).toThrow('OPENAPI_ENABLED');
  });
});
