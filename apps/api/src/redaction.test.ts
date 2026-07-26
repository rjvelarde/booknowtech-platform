import { describe, expect, it } from 'vitest';

import { redactSensitive } from './redaction.js';

describe('redactSensitive', () => {
  it('redacts sensitive keys recursively', () => {
    const result = redactSensitive({
      authorization: 'Bearer value',
      nested: { password: 'value', safe: 'retained' },
      list: [{ client_secret: 'value' }],
    });

    expect(result).toEqual({
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'retained' },
      list: [{ client_secret: '[REDACTED]' }],
    });
  });
});
