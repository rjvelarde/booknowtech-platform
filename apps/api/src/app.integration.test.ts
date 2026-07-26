import { afterEach, describe, expect, it } from 'vitest';

import { buildApplication } from './app.js';
import { StubReadinessProbe, testEnvironment } from './test-fixtures.js';

describe('operational API', () => {
  const applications: Awaited<ReturnType<typeof buildApplication>>[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map(async (app) => app.close()));
  });

  it('reports liveness independently of Atlas', async () => {
    const app = await buildApplication({
      environment: testEnvironment,
      readiness: new StubReadinessProbe(new Error('Atlas unavailable')),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'live' } });
  });

  it('reports healthy and unhealthy readiness safely', async () => {
    const healthy = await buildApplication({
      environment: testEnvironment,
      readiness: new StubReadinessProbe(),
      logger: false,
    });
    const unhealthy = await buildApplication({
      environment: testEnvironment,
      readiness: new StubReadinessProbe(new Error('mongodb://user:secret@host')),
      logger: false,
    });
    applications.push(healthy, unhealthy);

    const readyResponse = await healthy.inject({ method: 'GET', url: '/health/ready' });
    const failedResponse = await unhealthy.inject({ method: 'GET', url: '/health/ready' });

    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toEqual({ data: { status: 'ready' } });
    expect(failedResponse.statusCode).toBe(503);
    expect(failedResponse.body).not.toContain('secret');
  });

  it('returns safe version metadata and propagates valid correlation IDs', async () => {
    const app = await buildApplication({
      environment: testEnvironment,
      readiness: new StubReadinessProbe(),
      logger: false,
    });
    applications.push(app);
    const requestId = '550e8400-e29b-41d4-a716-446655440000';

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/version',
      headers: { 'x-request-id': requestId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.json()).toEqual({ data: { version: 'test-build' } });
  });

  it('generates an OpenAPI document for all operational endpoints', async () => {
    const app = await buildApplication({
      environment: testEnvironment,
      readiness: new StubReadinessProbe(),
      logger: false,
    });
    applications.push(app);
    await app.ready();

    const document = app.swagger();
    expect(document.paths).toHaveProperty('/health/live');
    expect(document.paths).toHaveProperty('/health/ready');
    expect(document.paths).toHaveProperty('/api/v1/version');

    const response = await app.inject({ method: 'GET', url: '/documentation/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths).toHaveProperty('/health/live');
  });

  it('does not expose OpenAPI in production mode', async () => {
    const app = await buildApplication({
      environment: { ...testEnvironment, NODE_ENV: 'production', OPENAPI_ENABLED: false },
      readiness: new StubReadinessProbe(),
      logger: false,
    });
    applications.push(app);

    const response = await app.inject({ method: 'GET', url: '/documentation/openapi.json' });
    expect(response.statusCode).toBe(404);
  });
});
