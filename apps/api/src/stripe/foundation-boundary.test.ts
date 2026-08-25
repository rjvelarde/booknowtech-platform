import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('PR 14B.2 Stripe execution boundary', () => {
  it('allows only create, retrieve, and cancel PaymentIntent operations', () => {
    const adapter = readFileSync(resolve(root, 'apps/api/src/stripe/adapter.ts'), 'utf8');
    expect(adapter.match(/paymentIntents\.(?:create|retrieve|cancel)/gu)).toEqual([
      'paymentIntents.create',
      'paymentIntents.retrieve',
      'paymentIntents.cancel',
    ]);
    const files = ['apps/api/src', 'apps/worker/src'].flatMap((directory) =>
      sourceFiles(resolve(root, directory)),
    );
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n');
    expect(source).not.toMatch(
      /setupIntents\.|charges\.create|refunds\.create|subscriptions\.create|invoices\.(?:create|pay)|checkout\.sessions|transfers\.create|paymentMethods\.|\.capture\(|payment_intent\.(?:succeeded|payment_failed|processing|canceled)/u,
    );
    expect(adapter).not.toMatch(/transfer_data|on_behalf_of|capture_method:\s*'manual'/u);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name)) &&
      entry.name !== 'foundation-boundary.test.ts'
      ? [path]
      : [];
  });
}
