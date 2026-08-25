import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CHECKOUT_RECOVERY_COOKIE = '__Secure-bnt_checkout_recovery';
export const CHECKOUT_RECOVERY_MAX_AGE_SECONDS = 3 * 60 * 60;

export function recoveryHostnameHash(hostname: string): string {
  return createHash('sha256').update(normalizeRecoveryHostname(hostname)).digest('hex');
}

export function issueRecoveryToken(input: {
  secret: string;
  tenantPublicId: string;
  attemptPublicId: string;
  hostnameHash: string;
  expiresAt: Date;
}): string {
  return createHmac('sha256', input.secret)
    .update(
      [
        'bnt_checkout_recovery_v1',
        input.tenantPublicId,
        input.attemptPublicId,
        input.hostnameHash,
        input.expiresAt.toISOString(),
      ].join(':'),
    )
    .digest('base64url');
}

export function recoveryTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function recoveryTokenMatches(expectedHash: string, token: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash) || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  return timingSafeEqual(
    Buffer.from(expectedHash, 'hex'),
    Buffer.from(recoveryTokenHash(token), 'hex'),
  );
}

export function recoveryCookie(token: string, maxAgeSeconds: number): string {
  return `${CHECKOUT_RECOVERY_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/api/v1/public/payment-attempts/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearRecoveryCookie(): string {
  return `${CHECKOUT_RECOVERY_COOKIE}=; Max-Age=0; Path=/api/v1/public/payment-attempts/; Secure; HttpOnly; SameSite=Lax`;
}

export function recoveryCookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === CHECKOUT_RECOVERY_COOKIE) return value.join('=') || null;
  }
  return null;
}

function normalizeRecoveryHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/u, '');
}
