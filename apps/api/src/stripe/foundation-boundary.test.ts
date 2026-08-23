import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('PR 14A money-movement boundary', () => {
  it('does not add a ledger collection or Stripe payment execution calls', () => {
    const files = [
      'apps/api/src/stripe/adapter.ts',
      'apps/api/src/stripe/connect-service.ts',
      'apps/api/src/stripe/connect-store.ts',
      'apps/api/src/stripe/webhook-store.ts',
      'apps/worker/src/stripe-webhook-worker.ts',
      'apps/api/src/database/migrate.ts',
    ];
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n');
    expect(source).not.toMatch(/payment_ledger_entries/u);
    expect(source).not.toMatch(
      /paymentIntents\.|setupIntents\.|charges\.create|refunds\.create|subscriptions\.create|invoices\.|checkout\.sessions|transfers\.create|paymentMethods\.|application_fee|transfer_data|on_behalf_of/u,
    );
  });
});
