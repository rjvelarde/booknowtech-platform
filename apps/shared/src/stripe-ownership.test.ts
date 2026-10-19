import { describe, expect, it } from 'vitest';
import {
  externalAccountManifest,
  isReservedExternalAccount,
  matchExternalRule,
} from './stripe-ownership.js';
const rule = externalAccountManifest[0]!;
const input = {
  accountId: rule.accountId,
  platformAccountId: rule.platformAccountId,
  environment: 'production',
  livemode: true,
  eventType: 'payment_intent.succeeded',
  now: new Date('2026-10-20T00:00:00Z'),
};
describe('reviewed external ownership manifest', () => {
  it('contains only the approved account and reserves it even after expiry', () => {
    expect(externalAccountManifest).toHaveLength(1);
    expect(isReservedExternalAccount(rule.accountId)).toBe(true);
    expect(isReservedExternalAccount('acct_unknown')).toBe(false);
    expect(matchExternalRule(input)?.version).toBe('yii-external-v1');
  });
  it.each([
    { accountId: 'acct_unknown' },
    { platformAccountId: 'acct_wrong' },
    { environment: 'staging' },
    { livemode: false },
    { eventType: 'charge.refunded' },
    { now: new Date(rule.expiresAt) },
    { now: new Date('2026-10-18T00:00:00Z') },
  ])('requires exact scope and a current approval: %j', (change) => {
    expect(matchExternalRule({ ...input, ...change })).toBeNull();
  });
  it.each([
    { approvedBy: '' },
    { evidenceReference: '' },
    { version: '' },
    { owningApplication: 'unknown' },
    { expiresAt: 'invalid' },
    { reviewAt: '2026-10-19T00:00:00Z' },
  ])('refuses unverified entries: %j', (change) => {
    expect(matchExternalRule(input, [{ ...rule, ...change }])).toBeNull();
  });
  it('refuses ambiguous ownership even if only one conflicting entry is currently valid', () => {
    expect(
      matchExternalRule(input, [rule, { ...rule, expiresAt: '2026-10-18T00:00:00Z' }]),
    ).toBeNull();
  });
});
