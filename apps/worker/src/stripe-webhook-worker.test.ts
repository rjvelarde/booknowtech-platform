import { describe, expect, it } from 'vitest';

import { type StripeProjection, deriveConnectStatus } from './stripe-webhook-worker.js';

const projection = (overrides: Partial<StripeProjection> = {}): StripeProjection => ({
  details_submitted: true,
  charges_enabled: true,
  payouts_enabled: true,
  capabilities: { card_payments: 'active', transfers: 'active' },
  requirements: {
    currently_due: [],
    eventually_due: [],
    past_due: [],
    pending_verification: [],
    disabled_reason: null,
    current_deadline: null,
  },
  ...overrides,
});

describe('Stripe account readiness projection', () => {
  it('keeps payments and payouts as separate readiness states', () => {
    expect(deriveConnectStatus(projection())).toBe('payouts_enabled');
    expect(deriveConnectStatus(projection({ payouts_enabled: false }))).toBe('payments_enabled');
    expect(deriveConnectStatus(projection({ charges_enabled: false }))).toBe('restricted');
  });

  it('prioritizes restrictions and verification requirements over capability booleans', () => {
    expect(
      deriveConnectStatus(
        projection({
          requirements: { ...projection().requirements, disabled_reason: 'requirements.past_due' },
        }),
      ),
    ).toBe('disabled');
    expect(
      deriveConnectStatus(
        projection({
          requirements: { ...projection().requirements, currently_due: ['business_profile.url'] },
        }),
      ),
    ).toBe('action_required');
    expect(
      deriveConnectStatus(
        projection({
          requirements: {
            ...projection().requirements,
            pending_verification: ['individual.verification.document'],
          },
        }),
      ),
    ).toBe('pending_verification');
  });
});
