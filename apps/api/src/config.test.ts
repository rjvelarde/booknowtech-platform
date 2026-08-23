import { describe, expect, it } from 'vitest';

import { loadEnvironment } from './config.js';

const valid = {
  NODE_ENV: 'test',
  ENVIRONMENT_ID: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://user:password@localhost:27017',
  MONGODB_DATABASE: 'booknowtech_test',
  BUILD_VERSION: 'commit-abc123',
  BOOKING_ROOT_DOMAIN: 'booknowtech.com',
  ADMIN_ORIGIN: 'https://admin.example.test',
  TENANT_ADMIN_ENABLED: 'false',
  OPENAPI_ENABLED: 'true',
  PUBLIC_APPOINTMENT_TOKEN_SECRET: 'test-secret-that-is-at-least-thirty-two-bytes-long',
  RATE_LIMIT_KEY_SECRET: 'test-rate-limit-secret-at-least-thirty-two-bytes',
  MONITORING_TOKEN: 'bnt_monitoring_test_0123456789abcdef0123456789abcdef',
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
    expect(() =>
      loadEnvironment({
        ...valid,
        NODE_ENV: 'production',
        ENVIRONMENT_ID: 'production',
        MONGODB_DATABASE: 'booknowtech_production',
      }),
    ).toThrow('OPENAPI_ENABLED');
  });

  it('enforces environment, Railway, database, and hostname pairings', () => {
    expect(() => loadEnvironment({ ...valid, ENVIRONMENT_ID: 'staging' })).toThrow('NODE_ENV');
    expect(() => loadEnvironment({ ...valid, RAILWAY_ENVIRONMENT_NAME: 'production' })).toThrow(
      'RAILWAY_ENVIRONMENT_NAME',
    );
    expect(() =>
      loadEnvironment({
        ...valid,
        NODE_ENV: 'staging',
        ENVIRONMENT_ID: 'staging',
        MONGODB_DATABASE: 'booknowtech_production',
        BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
      }),
    ).toThrow('MONGODB_DATABASE');
  });

  it('derives Railway build identity from the immutable commit SHA', () => {
    const environment = loadEnvironment({
      ...valid,
      NODE_ENV: 'staging',
      ENVIRONMENT_ID: 'staging',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
      MONGODB_DATABASE: 'booknowtech_staging',
      BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
      BUILD_VERSION: 'operator-value-is-ignored',
      MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
    });
    expect(environment.BUILD_VERSION).toBe('a'.repeat(40));
  });

  it('accepts the exact production matrix and rejects production seed variables', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      ENVIRONMENT_ID: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'production',
      RAILWAY_GIT_COMMIT_SHA: 'c'.repeat(40),
      MONGODB_DATABASE: 'booknowtech_production',
      OPENAPI_ENABLED: 'false',
      MONITORING_TOKEN: 'bnt_monitoring_production_0123456789abcdef0123456789abcdef',
    };
    expect(loadEnvironment(production)).toMatchObject({
      NODE_ENV: 'production',
      MONGODB_DATABASE: 'booknowtech_production',
      BUILD_VERSION: 'c'.repeat(40),
    });
    expect(() => loadEnvironment({ ...production, ALLOW_DEVELOPMENT_SEED: 'true' })).toThrow(
      'production seed variables',
    );
  });

  it('requires an environment-specific monitoring token distinct from application secrets', () => {
    const staging = {
      ...valid,
      NODE_ENV: 'staging',
      ENVIRONMENT_ID: 'staging',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
      MONGODB_DATABASE: 'booknowtech_staging',
      BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
    };
    expect(() => loadEnvironment(staging)).toThrow('MONITORING_TOKEN environment');
    expect(() =>
      loadEnvironment({
        ...staging,
        MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
      }),
    ).not.toThrow();
    expect(() =>
      loadEnvironment({ ...valid, MONITORING_TOKEN: valid.RATE_LIMIT_KEY_SECRET }),
    ).toThrow('MONITORING_TOKEN');
  });

  it('keeps disabled Stripe optional but requires a complete, separated test-mode configuration when enabled', () => {
    expect(loadEnvironment(valid).STRIPE_PAYMENTS_FOUNDATION_ENABLED).toBe(false);
    const stripe = {
      ...valid,
      STRIPE_SECRET_KEY: 'sk_test_valid_foundation_key',
      STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_distinct_secret',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_distinct_secret',
      BOOKNOWTECH_CONNECT_TERMS_VERSION: 'connect-v1',
      BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256: 'a'.repeat(64),
      STRIPE_PAYMENTS_FOUNDATION_ENABLED: 'true',
    };
    expect(loadEnvironment(stripe)).toMatchObject({ STRIPE_PAYMENTS_FOUNDATION_ENABLED: true });
    expect(() =>
      loadEnvironment({
        ...stripe,
        STRIPE_CONNECT_WEBHOOK_SECRET: stripe.STRIPE_PLATFORM_WEBHOOK_SECRET,
      }),
    ).toThrow('separation');
    expect(() =>
      loadEnvironment({ ...stripe, STRIPE_SECRET_KEY: 'sk_live_wrong_environment' }),
    ).toThrow('key mode');
  });
});
