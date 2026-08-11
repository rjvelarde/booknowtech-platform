import { describe, expect, it } from 'vitest';
import { authorizeProvisioning } from './guard.js';

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
  PROVISIONING_OPERATOR_ID: 'Operator.One@BookNowTech.com',
  PROVISIONING_REASON: 'Provision approved design partner for launch readiness.',
  PROVISIONING_APPROVED: 'true',
};

describe('authorizeProvisioning', () => {
  it('validates the complete environment before a database connection and normalizes the operator', () => {
    expect(authorizeProvisioning(valid)).toMatchObject({
      operatorId: 'operator.one@booknowtech.com',
      reason: valid.PROVISIONING_REASON,
      environment: { ENVIRONMENT_ID: 'staging' },
    });
  });

  it.each([
    'PROVISIONING_OPERATOR_ID',
    'PROVISIONING_REASON',
    'PROVISIONING_APPROVED',
    'RAILWAY_ENVIRONMENT_NAME',
  ])('rejects a missing %s without exposing configuration values', (name) => {
    const source = { ...valid };
    delete source[name as keyof typeof source];
    expect(() => authorizeProvisioning(source)).toThrow();
    expect(() => authorizeProvisioning(source)).not.toThrow(/password@localhost/u);
  });
});
