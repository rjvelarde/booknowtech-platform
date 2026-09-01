import { describe, expect, it } from 'vitest';

import { CONNECT_WEBHOOK_EVENT_TYPES } from './webhook-store.js';

describe('canonical Connect webhook allowlist', () => {
  it('contains exactly the approved fourteen events', () => {
    expect(CONNECT_WEBHOOK_EVENT_TYPES).toEqual([
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
    ]);
    expect(CONNECT_WEBHOOK_EVENT_TYPES).not.toContain('charge.refunded');
  });
});
