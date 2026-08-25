import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_RECOVERY_COOKIE,
  clearRecoveryCookie,
  issueRecoveryToken,
  recoveryCookie,
  recoveryCookieToken,
  recoveryHostnameHash,
  recoveryTokenHash,
  recoveryTokenMatches,
} from './recovery.js';

describe('checkout recovery credential', () => {
  const input = {
    secret: 'recovery-secret-distinct-and-long-enough',
    tenantPublicId: 'tenant-public',
    attemptPublicId: 'attempt-public',
    hostnameHash: recoveryHostnameHash('Booking.Example.COM.'),
    expiresAt: new Date('2026-08-25T20:00:00.000Z'),
  };

  it('is opaque, deterministic for reissue, and bound to tenant, attempt, host, and expiry', () => {
    const token = issueRecoveryToken(input);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toContain('tenant-public');
    expect(issueRecoveryToken(input)).toBe(token);
    expect(issueRecoveryToken({ ...input, attemptPublicId: 'other' })).not.toBe(token);
    expect(issueRecoveryToken({ ...input, tenantPublicId: 'other' })).not.toBe(token);
    expect(
      issueRecoveryToken({ ...input, hostnameHash: recoveryHostnameHash('other.test') }),
    ).not.toBe(token);
    expect(recoveryTokenMatches(recoveryTokenHash(token), token)).toBe(true);
    expect(recoveryTokenMatches(recoveryTokenHash(token), `${token.slice(0, -1)}x`)).toBe(false);
  });

  it('uses a bounded host-only HttpOnly cookie and never places the token in a URL', () => {
    const token = issueRecoveryToken(input);
    const cookie = recoveryCookie(token, 10_800);
    expect(cookie).toContain(`${CHECKOUT_RECOVERY_COOKIE}=${token}`);
    expect(cookie).toContain('Max-Age=10800');
    expect(cookie).toContain('Path=/api/v1/public/payment-attempts/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
    expect(recoveryCookieToken(cookie)).toBe(token);
    expect(clearRecoveryCookie()).toContain('Max-Age=0');
  });
});
