import type { Environment } from './config.js';
import type { ReadinessProbe } from './readiness.js';

export const testEnvironment: Environment = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  LOG_LEVEL: 'fatal',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DATABASE: 'booknowtech_test',
  BUILD_VERSION: 'test-build',
  ADMIN_ORIGIN: 'https://admin.example.test',
  TENANT_ADMIN_ENABLED: false,
  OPENAPI_ENABLED: true,
  PUBLIC_APPOINTMENT_TOKEN_SECRET: 'test-secret-that-is-at-least-thirty-two-bytes-long',
  RATE_LIMIT_KEY_SECRET: 'test-rate-limit-secret-at-least-thirty-two-bytes',
};

export class StubReadinessProbe implements ReadinessProbe {
  public constructor(private readonly error?: Error) {}

  public check(): Promise<void> {
    return this.error ? Promise.reject(this.error) : Promise.resolve();
  }

  public async close(): Promise<void> {}
}
