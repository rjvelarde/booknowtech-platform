import { describe, expect, it } from 'vitest';
import { authorizePaymentConfiguration } from './configuration-authorization.js';

const valid = {
  NODE_ENV: 'staging',
  ENVIRONMENT_ID: 'staging',
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
  HOST: '127.0.0.1',
  PORT: '8080',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://user:password@localhost:27017',
  MONGODB_DATABASE: 'booknowtech_staging',
  BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
  ADMIN_ORIGIN: 'https://admin.staging.booknowtech.com',
  TENANT_ADMIN_ENABLED: 'true',
  OPENAPI_ENABLED: 'true',
  PUBLIC_APPOINTMENT_TOKEN_SECRET: 'a-safe-public-appointment-secret-value',
  RATE_LIMIT_KEY_SECRET: 'a-different-safe-rate-limit-secret-value',
  MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
  PAYMENT_CONFIGURATION_OPERATOR_ID: 'Operator.One@BookNowTech.com',
  PAYMENT_CONFIGURATION_REASON: 'Approved configuration for one named design partner.',
  PAYMENT_CONFIGURATION_APPROVED: 'true',
};

describe('payment configuration authorization', () => {
  it('requires Railway, explicit approval, and normalizes the operator', () => {
    expect(authorizePaymentConfiguration(valid)).toMatchObject({
      operatorId: 'operator.one@booknowtech.com',
      environment: { ENVIRONMENT_ID: 'staging', MONGODB_DATABASE: 'booknowtech_staging' },
    });
  });

  it.each([
    'PAYMENT_CONFIGURATION_OPERATOR_ID',
    'PAYMENT_CONFIGURATION_REASON',
    'PAYMENT_CONFIGURATION_APPROVED',
    'RAILWAY_ENVIRONMENT_NAME',
  ])('rejects missing %s', (name) => {
    const source = { ...valid } as Record<string, string>;
    delete source[name];
    expect(() => authorizePaymentConfiguration(source)).toThrow();
  });

  it('rejects a mismatched database before mutation', () => {
    expect(() =>
      authorizePaymentConfiguration({ ...valid, MONGODB_DATABASE: 'booknowtech_production' }),
    ).toThrow('MONGODB_DATABASE');
  });
});
