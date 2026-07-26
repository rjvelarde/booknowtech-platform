import { describe, expect, it } from 'vitest';

import { loadWorkerEnvironment } from './config.js';

describe('loadWorkerEnvironment', () => {
  it('loads valid worker settings', () => {
    expect(
      loadWorkerEnvironment({ NODE_ENV: 'test', LOG_LEVEL: 'info', BUILD_VERSION: 'test' }),
    ).toEqual({ NODE_ENV: 'test', LOG_LEVEL: 'info', BUILD_VERSION: 'test' });
  });

  it('fails without echoing an invalid build value', () => {
    expect(() =>
      loadWorkerEnvironment({
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        BUILD_VERSION: 'secret invalid value',
      }),
    ).toThrow('BUILD_VERSION');
    expect(() =>
      loadWorkerEnvironment({
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        BUILD_VERSION: 'secret invalid value',
      }),
    ).not.toThrow(/secret invalid value/);
  });
});
