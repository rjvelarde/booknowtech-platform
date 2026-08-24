import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('PR 14B.1 money-movement boundary', () => {
  it('permits financial snapshots but no Stripe execution call', () => {
    const files = ['apps/api/src', 'apps/worker/src', 'apps/frontend/src'].flatMap((directory) =>
      sourceFiles(resolve(root, directory)),
    );
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n');
    expect(source).not.toMatch(
      /paymentIntents\.|setupIntents\.|charges\.create|refunds\.|subscriptions\.create|invoices\.(?:create|pay)|checkout\.sessions|transfers\.create|paymentMethods\.|\.capture\(|@stripe\/stripe-js|PaymentElement|payment_intent\.(?:succeeded|payment_failed|processing|canceled)/u,
    );
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
