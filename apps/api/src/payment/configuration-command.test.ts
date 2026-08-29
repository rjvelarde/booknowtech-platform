import { describe, expect, it } from 'vitest';
import { parsePaymentConfigurationArguments } from './configuration-cli.js';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

describe('payment configuration command arguments', () => {
  it('parses the three bounded operations', () => {
    expect(
      parsePaymentConfigurationArguments([
        'set-booking-fee',
        '--request-id',
        requestId,
        '--tenant',
        'partner',
        '--amount-minor',
        '125',
      ]),
    ).toMatchObject({ amountMinor: 125 });
    expect(
      parsePaymentConfigurationArguments([
        'set-service-config',
        '--request-id',
        requestId,
        '--tenant',
        'partner',
        '--service-public-id',
        requestId,
        '--mode',
        'fixed_deposit',
        '--fixed-deposit-minor',
        '2500',
      ]),
    ).toMatchObject({ paymentMode: 'fixed_deposit', fixedDepositMinor: 2500 });
    expect(
      parsePaymentConfigurationArguments([
        'set-tenant-execution',
        '--request-id',
        requestId,
        '--tenant',
        'partner',
        '--status',
        'disabled',
      ]),
    ).toMatchObject({ enabled: false });
  });

  it.each([
    [
      'set-booking-fee',
      '--request-id',
      'UPPERCASE',
      '--tenant',
      'partner',
      '--amount-minor',
      '1.25',
    ],
    [
      'set-service-config',
      '--request-id',
      requestId,
      '--tenant',
      'partner',
      '--service-public-id',
      requestId,
      '--mode',
      'percentage',
    ],
    ['set-tenant-execution', '--request-id', requestId, '--tenant', 'partner', '--status', 'true'],
  ])('rejects invalid or expanded input %#', (...args) => {
    expect(() => parsePaymentConfigurationArguments(args)).toThrow();
  });
});
