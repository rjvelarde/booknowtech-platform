import { describe, expect, it } from 'vitest';
import { observeTxt } from './dns.js';

describe('DNS TXT observation', () => {
  it('joins provider-split chunks and keeps separate TXT records', async () => {
    await expect(
      observeTxt(
        {
          resolveTxt: () =>
            Promise.resolve([['booknowtech-', 'verification=token'], ['unrelated']]),
        },
        '_booknowtech.book.example.com',
      ),
    ).resolves.toEqual({
      kind: 'answers',
      values: ['booknowtech-verification=token', 'unrelated'],
    });
  });
  it.each([
    ['ENOTFOUND', 'not_found'],
    ['ENODATA', 'not_found'],
    ['ETIMEOUT', 'temporary_failure'],
    ['ESERVFAIL', 'temporary_failure'],
  ])('classifies %s safely', async (code, kind) => {
    await expect(
      observeTxt(
        {
          resolveTxt: () =>
            Promise.reject(Object.assign(new Error('secret resolver detail'), { code })),
        },
        'name',
      ),
    ).resolves.toEqual({ kind });
  });
});
