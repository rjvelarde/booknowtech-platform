import { z } from 'zod';
import { loadEnvironment } from '../config.js';

const schema = z.object({
  PAYMENT_RECONCILIATION_OPERATOR_ID: z.string().trim().min(3).max(120),
  PAYMENT_RECONCILIATION_REASON: z.string().trim().min(10).max(500),
  PAYMENT_RECONCILIATION_REQUEUE_APPROVED: z.literal('true'),
});

export function authorizePaymentReconciliationRequeue(source: NodeJS.ProcessEnv = process.env) {
  const environment = loadEnvironment(source);
  if (!['staging', 'production'].includes(environment.ENVIRONMENT_ID))
    throw new Error('payment_reconciliation_requeue_environment_denied');
  if (!environment.RAILWAY_ENVIRONMENT_NAME)
    throw new Error('payment_reconciliation_requeue_railway_required');
  const authorization = schema.parse(source);
  return {
    environment,
    operatorId: authorization.PAYMENT_RECONCILIATION_OPERATOR_ID,
    reason: authorization.PAYMENT_RECONCILIATION_REASON,
  };
}
