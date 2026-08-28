import { describe, expect, it } from 'vitest';
import { testEnvironment } from '../test-fixtures.js';
import { authorizeMonitoringAcknowledgement } from './acknowledgement-authorization.js';

describe('monitoring acknowledgement authorization', () => {
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
    MONGODB_DATABASE: 'booknowtech_staging',
    BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
    MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
    MONITORING_OPERATOR_ID: 'booknowtech-operator',
    MONITORING_ACKNOWLEDGEMENT_REASON:
      'Reviewed terminal historical evidence and approved acknowledgement.',
    MONITORING_ACKNOWLEDGEMENT_APPROVED: 'true',
  };

  it('requires the explicit approved Railway operator path', () => {
    expect(authorizeMonitoringAcknowledgement(approved)).toMatchObject({
      operatorId: 'booknowtech-operator',
      reason: approved.MONITORING_ACKNOWLEDGEMENT_REASON,
    });
    for (const missing of [
      'RAILWAY_ENVIRONMENT_NAME',
      'MONITORING_OPERATOR_ID',
      'MONITORING_ACKNOWLEDGEMENT_REASON',
      'MONITORING_ACKNOWLEDGEMENT_APPROVED',
    ]) {
      const candidate = { ...approved };
      delete candidate[missing];
      expect(() => authorizeMonitoringAcknowledgement(candidate)).toThrow();
    }
  });

  it('denies non-deployment environments', () => {
    const development: NodeJS.ProcessEnv = {
      ...approved,
      NODE_ENV: 'development',
      ENVIRONMENT_ID: 'development',
    };
    delete development.RAILWAY_ENVIRONMENT_NAME;
    delete development.RAILWAY_GIT_COMMIT_SHA;
    expect(() => authorizeMonitoringAcknowledgement(development)).toThrow(
      'monitoring_acknowledgement_environment_denied',
    );
  });
});
