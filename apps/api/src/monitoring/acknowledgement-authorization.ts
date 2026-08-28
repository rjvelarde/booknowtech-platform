import { z } from 'zod';
import { type Environment, loadEnvironment } from '../config.js';

const schema = z.object({
  MONITORING_OPERATOR_ID: z.string().trim().min(3).max(120),
  MONITORING_ACKNOWLEDGEMENT_REASON: z.string().trim().min(10).max(500),
  MONITORING_ACKNOWLEDGEMENT_APPROVED: z.literal('true'),
});

export function authorizeMonitoringAcknowledgement(source: NodeJS.ProcessEnv = process.env): {
  environment: Environment;
  operatorId: string;
  reason: string;
} {
  const environment = loadEnvironment(source);
  if (!['staging', 'production'].includes(environment.ENVIRONMENT_ID))
    throw new Error('monitoring_acknowledgement_environment_denied');
  if (!environment.RAILWAY_ENVIRONMENT_NAME)
    throw new Error('monitoring_acknowledgement_railway_required');
  const authorization = schema.parse(source);
  return {
    environment,
    operatorId: authorization.MONITORING_OPERATOR_ID,
    reason: authorization.MONITORING_ACKNOWLEDGEMENT_REASON,
  };
}
