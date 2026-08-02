import { describe, expect, it } from 'vitest';

import { buildPostmarkMetadata } from './notification-worker.js';

describe('buildPostmarkMetadata', () => {
  it('uses a Postmark-compatible metadata field name', () => {
    const metadata = buildPostmarkMetadata('28c93e87-3f11-4864-ac8a-d510f9e557fd');

    expect(metadata).toEqual({
      notification_id: '28c93e87-3f11-4864-ac8a-d510f9e557fd',
    });
    expect(Object.keys(metadata).every((fieldName) => fieldName.length <= 20)).toBe(true);
    expect(Object.values(metadata).every((value) => value.length <= 80)).toBe(true);
  });
});
