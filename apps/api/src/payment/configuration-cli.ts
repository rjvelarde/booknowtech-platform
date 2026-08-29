import { PAYMENT_MODES, type PaymentMode } from './domain.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const slug = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface PaymentConfigurationArguments {
  command: 'set-booking-fee' | 'set-service-config' | 'set-tenant-execution';
  requestId: string;
  tenantSlug: string;
  amountMinor?: number;
  servicePublicId?: string;
  paymentMode?: PaymentMode;
  fixedDepositMinor?: number;
  enabled?: boolean;
}

export function parsePaymentConfigurationArguments(args: string[]): PaymentConfigurationArguments {
  if (args[0] === '--') args = args.slice(1);
  const command = args[0] as PaymentConfigurationArguments['command'];
  if (!['set-booking-fee', 'set-service-config', 'set-tenant-execution'].includes(command))
    throw new Error('payment_configuration_arguments_invalid');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key))
      throw new Error('payment_configuration_arguments_invalid');
    values.set(key, value);
  }
  const requestId = values.get('--request-id');
  const tenantSlug = values.get('--tenant');
  if (!requestId || !uuid.test(requestId) || !tenantSlug || !slug.test(tenantSlug))
    throw new Error('payment_configuration_arguments_invalid');
  if (command === 'set-booking-fee') {
    const amountMinor = integer(values.get('--amount-minor'));
    if (values.size !== 3 || amountMinor === undefined)
      throw new Error('payment_configuration_arguments_invalid');
    return { command, requestId, tenantSlug, amountMinor };
  }
  if (command === 'set-service-config') {
    const servicePublicId = values.get('--service-public-id');
    const paymentMode = values.get('--mode') as PaymentMode | undefined;
    const fixedDepositMinor = integer(values.get('--fixed-deposit-minor'));
    const expected = paymentMode === 'fixed_deposit' ? 5 : 4;
    if (
      !servicePublicId ||
      !uuid.test(servicePublicId) ||
      !paymentMode ||
      !PAYMENT_MODES.includes(paymentMode) ||
      values.size !== expected
    )
      throw new Error('payment_configuration_arguments_invalid');
    return {
      command,
      requestId,
      tenantSlug,
      servicePublicId,
      paymentMode,
      ...(fixedDepositMinor === undefined ? {} : { fixedDepositMinor }),
    };
  }
  const status = values.get('--status');
  if (values.size !== 3 || !['enabled', 'disabled'].includes(status ?? ''))
    throw new Error('payment_configuration_arguments_invalid');
  return { command, requestId, tenantSlug, enabled: status === 'enabled' };
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
