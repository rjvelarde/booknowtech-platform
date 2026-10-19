/** Server-only, reviewed ownership evidence. Never infer ownership from event metadata. */
export interface ExternalAccountRule {
  version: string;
  platformAccountId: string;
  environment: 'production' | 'staging';
  livemode: boolean;
  accountId: string;
  owningApplication: string;
  evidenceReference: string;
  approvedBy: string;
  approvedAt: string;
  reviewAt: string;
  expiresAt: string;
  eventTypes: readonly string[];
}

export const externalAccountManifest: readonly ExternalAccountRule[] = [
  {
    version: 'yii-external-v1',
    platformAccountId: 'acct_1SueWg1GUsf7TOUR',
    environment: 'production',
    livemode: true,
    accountId: 'acct_1TbN5X7paPYfpGLT',
    owningApplication: 'legacy-yii-captain-booking',
    evidenceReference: 'docs/ops/STRIPE_EXTERNAL_ACCOUNT_OWNERSHIP.md#yii-external-v1',
    approvedBy: 'robert.velarde',
    approvedAt: '2026-10-19T00:00:00.000Z',
    reviewAt: '2026-11-18T00:00:00.000Z',
    expiresAt: '2026-11-18T00:00:00.000Z',
    eventTypes: [
      'account.application.deauthorized',
      'account.updated',
      'charge.dispute.closed',
      'charge.dispute.created',
      'charge.dispute.funds_reinstated',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.updated',
      'payment_intent.canceled',
      'payment_intent.payment_failed',
      'payment_intent.processing',
      'payment_intent.succeeded',
      'refund.created',
      'refund.failed',
      'refund.updated',
    ],
  },
];

// Reservation survives expiry and environment changes. Removing it requires ownership review.
export function isReservedExternalAccount(accountId: string): boolean {
  return externalAccountManifest.some((rule) => rule.accountId === accountId);
}

export function matchExternalRule(
  input: {
    accountId: string;
    platformAccountId: string;
    environment: string;
    livemode: boolean;
    eventType: string;
    now: Date;
  },
  manifest: readonly ExternalAccountRule[] = externalAccountManifest,
): ExternalAccountRule | null {
  const candidates = manifest.filter((rule) => rule.accountId === input.accountId);
  const matches = candidates.filter((rule) => {
    const approved = Date.parse(rule.approvedAt),
      review = Date.parse(rule.reviewAt),
      expires = Date.parse(rule.expiresAt);
    return (
      rule.platformAccountId === input.platformAccountId &&
      rule.environment === input.environment &&
      rule.livemode === input.livemode &&
      input.livemode === (input.environment === 'production') &&
      rule.owningApplication === 'legacy-yii-captain-booking' &&
      rule.approvedBy.trim().length > 0 &&
      rule.evidenceReference.trim().length > 0 &&
      rule.version.trim().length > 0 &&
      Number.isFinite(approved) &&
      Number.isFinite(review) &&
      Number.isFinite(expires) &&
      approved <= input.now.valueOf() &&
      input.now.valueOf() < Math.min(review, expires) &&
      rule.eventTypes.includes(input.eventType)
    );
  });
  return matches.length === 1 && candidates.length === 1 ? matches[0]! : null;
}
