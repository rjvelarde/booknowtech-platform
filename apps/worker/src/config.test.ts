import { describe, expect, it } from 'vitest';

import { loadWorkerEnvironment } from './config.js';

describe('loadWorkerEnvironment', () => {
  const valid = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    BUILD_VERSION: 'test',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DATABASE: 'booknowtech_test',
    TRANSACTIONAL_EMAIL_PROVIDER: 'postmark',
    TRANSACTIONAL_EMAIL_TOKEN: 'test-token',
    TRANSACTIONAL_EMAIL_FROM: 'appointments@example.com',
  } as const;

  it('loads valid worker settings', () => {
    expect(loadWorkerEnvironment(valid)).toEqual(valid);
  });

  it('fails without echoing an invalid build value', () => {
    expect(() =>
      loadWorkerEnvironment({
        ...valid,
        BUILD_VERSION: 'secret invalid value',
      }),
    ).toThrow('BUILD_VERSION');
    expect(() =>
      loadWorkerEnvironment({
        ...valid,
        BUILD_VERSION: 'secret invalid value',
      }),
    ).not.toThrow(/secret invalid value/);
  });
});
