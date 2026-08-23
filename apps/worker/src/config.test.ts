import { describe, expect, it } from 'vitest';

import { loadWorkerEnvironment } from './config.js';

describe('loadWorkerEnvironment', () => {
  const valid = {
    NODE_ENV: 'test',
    ENVIRONMENT_ID: 'test',
    LOG_LEVEL: 'info',
    BUILD_VERSION: 'test',
    BOOKING_ROOT_DOMAIN: 'booknowtech.com',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DATABASE: 'booknowtech_test',
    TRANSACTIONAL_EMAIL_PROVIDER: 'postmark',
    TRANSACTIONAL_EMAIL_TOKEN: 'valid-postmark-token',
    TRANSACTIONAL_EMAIL_FROM: 'appointments@example.com',
    POSTMARK_SERVER_ID: '12345',
    PUBLIC_APPOINTMENT_TOKEN_SECRET: 'test-secret-that-is-at-least-thirty-two-bytes-long',
  } as const;

  it('loads valid worker settings', () => {
    expect(loadWorkerEnvironment(valid)).toMatchObject({ ...valid, POSTMARK_SERVER_ID: 12345 });
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

  it('enforces staging pairings and Railway build identity', () => {
    expect(() =>
      loadWorkerEnvironment({
        ...valid,
        NODE_ENV: 'staging',
        ENVIRONMENT_ID: 'staging',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40),
        MONGODB_DATABASE: 'booknowtech_production',
        BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
      }),
    ).toThrow('MONGODB_DATABASE');
    expect(
      loadWorkerEnvironment({
        ...valid,
        NODE_ENV: 'staging',
        ENVIRONMENT_ID: 'staging',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40),
        MONGODB_DATABASE: 'booknowtech_staging',
        BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
      }).BUILD_VERSION,
    ).toBe('b'.repeat(40));
  });

  it('accepts only the exact production database and hostname matrix', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      ENVIRONMENT_ID: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'production',
      RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40),
      MONGODB_DATABASE: 'booknowtech_production',
      BOOKING_ROOT_DOMAIN: 'booknowtech.com',
    };
    expect(loadWorkerEnvironment(production)).toMatchObject({
      NODE_ENV: 'production',
      MONGODB_DATABASE: 'booknowtech_production',
      BUILD_VERSION: 'd'.repeat(40),
    });
    expect(() =>
      loadWorkerEnvironment({ ...production, BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' }),
    ).toThrow('BOOKING_ROOT_DOMAIN');
  });

  it('enforces environment-specific Stripe key mode without requiring Stripe for legacy work', () => {
    expect(loadWorkerEnvironment(valid).STRIPE_SECRET_KEY).toBeUndefined();
    expect(
      loadWorkerEnvironment({ ...valid, STRIPE_SECRET_KEY: 'sk_test_worker_key' })
        .STRIPE_SECRET_KEY,
    ).toBe('sk_test_worker_key');
    expect(() =>
      loadWorkerEnvironment({ ...valid, STRIPE_SECRET_KEY: 'sk_live_wrong_mode' }),
    ).toThrow('Stripe key mode');
  });
});
