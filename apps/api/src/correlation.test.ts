import { describe, expect, it } from 'vitest';

import { resolveCorrelationId } from './correlation.js';

describe('resolveCorrelationId', () => {
  it('preserves a valid UUID', () => {
    expect(resolveCorrelationId('019c-0000-0000-0000')).not.toBe('019c-0000-0000-0000');
    expect(resolveCorrelationId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('replaces missing or invalid values with a UUID', () => {
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(resolveCorrelationId('unsafe\nheader')).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
