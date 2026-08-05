import { describe, expect, it, vi } from 'vitest';

import { verifyPostmarkIdentity } from './postmark-readiness.js';

describe('Postmark deployment readiness', () => {
  it('accepts the configured server token only when its server ID matches', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ID: 42, Name: 'BookNowTech Staging' }), { status: 200 }),
      );
    await expect(
      verifyPostmarkIdentity(
        { POSTMARK_SERVER_ID: 42, TRANSACTIONAL_EMAIL_TOKEN: 'redacted-valid-token' },
        fetcher,
      ),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.postmarkapp.com/server',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects a token for the wrong environment server without exposing identity data', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ID: 99, Name: 'Wrong server' }), { status: 200 }),
      );
    await expect(
      verifyPostmarkIdentity(
        { POSTMARK_SERVER_ID: 42, TRANSACTIONAL_EMAIL_TOKEN: 'redacted-valid-token' },
        fetcher,
      ),
    ).rejects.toThrow('POSTMARK_SERVER_ID');
  });

  it('returns a bounded provider status when Postmark is unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      verifyPostmarkIdentity(
        { POSTMARK_SERVER_ID: 42, TRANSACTIONAL_EMAIL_TOKEN: 'redacted-valid-token' },
        fetcher,
      ),
    ).rejects.toThrow('provider_503');
  });
});
