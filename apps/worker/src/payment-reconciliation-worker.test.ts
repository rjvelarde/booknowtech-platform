import { describe, expect, it } from 'vitest';

import {
  MAX_RECONCILIATION_ATTEMPTS,
  RECONCILIATION_DELAYS_MILLISECONDS,
  retryAt,
} from './payment-reconciliation-worker.js';

describe('payment reconciliation retry schedule', () => {
  it('uses immediate plus bounded 1/5/15/30 minute recovery attempts', () => {
    expect(MAX_RECONCILIATION_ATTEMPTS).toBe(5);
    expect(RECONCILIATION_DELAYS_MILLISECONDS).toEqual([0, 60_000, 300_000, 900_000, 1_800_000]);
  });

  it('applies deterministic jitter within the approved fifteen percent bound', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    for (let attemptCount = 0; attemptCount < 4; attemptCount += 1) {
      const base = RECONCILIATION_DELAYS_MILLISECONDS[attemptCount + 1]!;
      const first = retryAt(
        { public_id: 'ca91de55-f0bf-46d5-a9f9-edc4061f4220', attempt_count: attemptCount },
        now,
      );
      const second = retryAt(
        { public_id: 'ca91de55-f0bf-46d5-a9f9-edc4061f4220', attempt_count: attemptCount },
        now,
      );
      const delay = first.valueOf() - now.valueOf();
      expect(first).toEqual(second);
      expect(delay).toBeGreaterThanOrEqual(base * 0.85);
      expect(delay).toBeLessThanOrEqual(base * 1.15);
    }
  });
});
