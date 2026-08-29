import { z } from 'zod';
import { loadEnvironment } from '../config.js';

const schema = z.object({
  PAYMENT_CONFIGURATION_OPERATOR_ID: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._@+-]*$/iu)
    .transform((value) => value.toLowerCase()),
  PAYMENT_CONFIGURATION_REASON: z.string().trim().min(10).max(500),
  PAYMENT_CONFIGURATION_APPROVED: z.literal('true'),
});

export function authorizePaymentConfiguration(source: NodeJS.ProcessEnv = process.env) {
  const environment = loadEnvironment(source);
  if (!['staging', 'production'].includes(environment.ENVIRONMENT_ID))
    throw new Error('payment_configuration_environment_denied');
  if (!environment.RAILWAY_ENVIRONMENT_NAME)
    throw new Error('payment_configuration_railway_required');
  const authorization = schema.parse(source);
  return {
    environment,
    operatorId: authorization.PAYMENT_CONFIGURATION_OPERATOR_ID,
    reason: authorization.PAYMENT_CONFIGURATION_REASON,
  };
}
