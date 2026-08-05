import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { testEnvironment } from '../test-fixtures.js';
import type { RateLimitDecision, RateLimitRequest, RateLimiter } from './limiter.js';
import { registerRateLimitHook } from './routes.js';

class CapturingLimiter implements RateLimiter {
  public readonly requests: RateLimitRequest[] = [];
  public constructor(private readonly result: RateLimitDecision | Error) {}
  public tenantKey(): string {
    return 'h:0123456789abcdef0123456789abcdef';
  }
  public consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.requests.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

class SequencedLimiter implements RateLimiter {
  public readonly requests: RateLimitRequest[] = [];
  public tenantKey(): string {
    return 'h:0123456789abcdef0123456789abcdef';
  }
  public consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.requests.push(request);
    return Promise.resolve({ ...rejected, allowed: true, count: 1 });
  }
}

const rejected: RateLimitDecision = {
  allowed: false,
  count: 31,
  limit: 30,
  retryAfterSeconds: 17,
  bucketStartedAt: new Date(0),
};

describe('shared route limiter', () => {
  it.each([
    [
      'GET',
      '/api/v1/public/booking-context',
      '/api/v1/public/booking-context',
      'public_discovery',
      'public_rate_limit_exceeded',
    ],
    [
      'GET',
      '/api/v1/public/services/s/providers/p/available-starts',
      '/api/v1/public/services/:servicePublicId/providers/:providerPublicId/available-starts',
      'public_availability',
      'public_rate_limit_exceeded',
    ],
    [
      'POST',
      '/api/v1/public/appointments',
      '/api/v1/public/appointments',
      'public_appointment_create',
      'public_rate_limit_exceeded',
    ],
    [
      'GET',
      '/api/v1/public/appointments/manage/11111111-1111-4111-8111-111111111111',
      '/api/v1/public/appointments/manage/:tokenPublicId',
      'management_read',
      'rate_limit_exceeded',
    ],
    [
      'GET',
      '/api/v1/public/appointments/manage/11111111-1111-4111-8111-111111111111/available-starts',
      '/api/v1/public/appointments/manage/:tokenPublicId/available-starts',
      'management_availability',
      'rate_limit_exceeded',
    ],
    [
      'POST',
      '/api/v1/public/appointments/manage/11111111-1111-4111-8111-111111111111/cancel',
      '/api/v1/public/appointments/manage/:tokenPublicId/cancel',
      'management_mutation',
      'rate_limit_exceeded',
    ],
  ])('limits %s %s with its safe envelope', async (method, url, route, scope, code) => {
    const limiter = new CapturingLimiter(rejected);
    const app = Fastify();
    registerRateLimitHook(app, testEnvironment, limiter);
    const httpMethod = method as 'GET' | 'POST';
    app.route({ method: httpMethod, url: route, handler: () => ({ data: {} }) });
    const response = await app.inject({
      method: httpMethod,
      url,
      headers: { host: 'tenant.booknowtech.com' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json().error.code).toBe(code);
    expect(limiter.requests[0]?.scope).toBe(scope);
    await app.close();
  });

  it('fails closed with a safe public response when Mongo is unavailable', async () => {
    const limiter = new CapturingLimiter(new Error('database unavailable'));
    const app = Fastify({ logger: false });
    registerRateLimitHook(app, testEnvironment, limiter);
    app.get('/api/v1/public/booking-context', () => ({ data: {} }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'tenant.booknowtech.com' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: 'service_unavailable',
      message: 'The request could not be completed.',
    });
    await app.close();
  });

  it('applies tenant-scoped IP and canonical contact limits to appointment creation', async () => {
    const limiter = new SequencedLimiter();
    const app = Fastify();
    registerRateLimitHook(app, testEnvironment, limiter);
    app.post('/api/v1/public/appointments', () => ({ data: {} }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: { host: 'tenant.booknowtech.com' },
      payload: {
        customer: { email: ' Person@Example.TEST ', mobile_phone: '(843) 555-0100' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(limiter.requests).toMatchObject([
      { scope: 'public_appointment_create', limit: 10, windowMilliseconds: 600_000 },
      {
        scope: 'public_appointment_contact',
        subject: 'person@example.test|+18435550100',
        limit: 10,
        windowMilliseconds: 3_600_000,
      },
    ]);
    await app.close();
  });
});
