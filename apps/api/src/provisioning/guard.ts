import { z } from 'zod';
import { type Environment, loadEnvironment } from '../config.js';

const operatorSchema = z.object({
  PROVISIONING_OPERATOR_ID: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._@+-]*$/iu)
    .transform((value) => value.toLowerCase()),
  PROVISIONING_REASON: z.string().trim().min(10).max(500),
  PROVISIONING_APPROVED: z.literal('true'),
});

export interface ProvisioningAuthorization {
  environment: Environment;
  operatorId: string;
  reason: string;
}

export function authorizeProvisioning(
  source: NodeJS.ProcessEnv = process.env,
): ProvisioningAuthorization {
  const environment = loadEnvironment(source);
  if (!['staging', 'production'].includes(environment.ENVIRONMENT_ID)) {
    throw new Error('Provisioning authorization denied: environment');
  }
  if (!environment.RAILWAY_ENVIRONMENT_NAME) {
    throw new Error('Provisioning authorization denied: Railway console required');
  }
  const result = operatorSchema.safeParse(source);
  if (!result.success) throw new Error('Provisioning authorization denied');
  return {
    environment,
    operatorId: result.data.PROVISIONING_OPERATOR_ID,
    reason: result.data.PROVISIONING_REASON,
  };
}
