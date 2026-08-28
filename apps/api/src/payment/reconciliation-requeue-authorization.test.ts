import { describe, expect, it } from 'vitest';
import { testEnvironment } from '../test-fixtures.js';
import { authorizePaymentReconciliationRequeue } from './reconciliation-requeue-authorization.js';

const base = Object.fromEntries(
  Object.entries(testEnvironment)
    .filter(
      (entry): entry is [string, Exclude<(typeof entry)[1], undefined>] => entry[1] !== undefined,
    )
    .map(([key, value]) => [key, String(value)]),
);
const approved: NodeJS.ProcessEnv = {
  ...base,
  NODE_ENV: 'staging',
  ENVIRONMENT_ID: 'staging',
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
  MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
  MONGODB_DATABASE: 'booknowtech_staging',
  BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
  PAYMENT_RECONCILIATION_OPERATOR_ID: 'operator@example.test',
  PAYMENT_RECONCILIATION_REASON: 'Human investigation approved one bounded recovery retry.',
  PAYMENT_RECONCILIATION_REQUEUE_APPROVED: 'true',
};

describe('payment reconciliation requeue authorization', () => {
  it('requires the explicit Railway operator approval path', () => {
    expect(authorizePaymentReconciliationRequeue(approved)).toMatchObject({
      operatorId: 'operator@example.test',
      reason: approved.PAYMENT_RECONCILIATION_REASON,
    });
    expect(() =>
      authorizePaymentReconciliationRequeue({
        ...approved,
        PAYMENT_RECONCILIATION_REQUEUE_APPROVED: undefined,
      }),
    ).toThrow();
    expect(() =>
      authorizePaymentReconciliationRequeue({ ...approved, RAILWAY_ENVIRONMENT_NAME: undefined }),
    ).toThrow('payment_reconciliation_requeue_railway_required');
  });
});
