import { describe, expect, it } from 'vitest';

import { hashRateLimitSubject } from './limiter.js';

const secret = 'unit-test-rate-limit-secret-longer-than-32-bytes';

describe('rate-limit keying', () => {
  it('produces deterministic fixed-length HMAC keys without exposing the subject', () => {
    const subject = '65.187.20.3|owner@example.test|raw-token';
    const first = hashRateLimitSubject(secret, subject);
    expect(first).toBe(hashRateLimitSubject(secret, subject));
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain('65.187');
    expect(first).not.toContain('owner');
    expect(first).not.toContain('token');
  });

  it('separates secrets and rejects unbounded subjects', () => {
    expect(hashRateLimitSubject(secret, 'subject')).not.toBe(
      hashRateLimitSubject(`${secret}-rotated`, 'subject'),
    );
    expect(() => hashRateLimitSubject(secret, 'x'.repeat(2_049))).toThrow(
      'Rate-limit subject is invalid',
    );
  });
});
