import { z } from 'zod';
import type { BookingRootDomain } from '@booknowtech/shared';

const gitSha = /^[a-f0-9]{40}$/u;
const unsafeSecret = /^(?:change|replace|example|test-token|secret)/iu;

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  ENVIRONMENT_ID: z.enum(['development', 'test', 'staging', 'production']),
  RAILWAY_ENVIRONMENT_NAME: z.string().min(1).optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().regex(gitSha).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  BUILD_VERSION: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._/-]+$/u)
    .optional(),
  BOOKING_ROOT_DOMAIN: z.enum(['booknowtech.com', 'staging.booknowtech.com']),
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1),
  TRANSACTIONAL_EMAIL_PROVIDER: z.literal('postmark'),
  TRANSACTIONAL_EMAIL_TOKEN: z.string().min(10),
  TRANSACTIONAL_EMAIL_FROM: z.string().email(),
  POSTMARK_SERVER_ID: z.coerce.number().int().positive(),
  PUBLIC_APPOINTMENT_TOKEN_SECRET: z.string().min(32),
  STRIPE_SECRET_KEY: z.string().min(16).optional(),
});

type ParsedWorkerEnvironment = z.infer<typeof environmentSchema>;
export type WorkerEnvironment = Omit<ParsedWorkerEnvironment, 'BUILD_VERSION'> & {
  BUILD_VERSION: string;
  BOOKING_ROOT_DOMAIN: BookingRootDomain;
};

export function loadWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }

  const environment = result.data;
  if (environment.NODE_ENV !== environment.ENVIRONMENT_ID)
    throw new Error('Invalid environment configuration: NODE_ENV, ENVIRONMENT_ID');
  if (
    environment.RAILWAY_ENVIRONMENT_NAME &&
    environment.RAILWAY_ENVIRONMENT_NAME !== environment.ENVIRONMENT_ID
  )
    throw new Error('Invalid environment configuration: RAILWAY_ENVIRONMENT_NAME, ENVIRONMENT_ID');
  const pairings: Partial<Record<ParsedWorkerEnvironment['ENVIRONMENT_ID'], [string, string]>> = {
    staging: ['booknowtech_staging', 'staging.booknowtech.com'],
    production: ['booknowtech_production', 'booknowtech.com'],
  };
  const required = pairings[environment.ENVIRONMENT_ID];
  if (required?.[0] !== undefined && environment.MONGODB_DATABASE !== required[0])
    throw new Error('Invalid environment configuration: MONGODB_DATABASE, ENVIRONMENT_ID');
  if (required?.[1] !== undefined && environment.BOOKING_ROOT_DOMAIN !== required[1])
    throw new Error('Invalid environment configuration: BOOKING_ROOT_DOMAIN, ENVIRONMENT_ID');
  if (unsafeSecret.test(environment.TRANSACTIONAL_EMAIL_TOKEN))
    throw new Error('Invalid environment configuration: TRANSACTIONAL_EMAIL_TOKEN');
  if (unsafeSecret.test(environment.PUBLIC_APPOINTMENT_TOKEN_SECRET))
    throw new Error('Invalid environment configuration: PUBLIC_APPOINTMENT_TOKEN_SECRET');
  if (environment.TRANSACTIONAL_EMAIL_TOKEN === environment.PUBLIC_APPOINTMENT_TOKEN_SECRET)
    throw new Error('Invalid environment configuration: environment-specific secrets');
  if (environment.STRIPE_SECRET_KEY) {
    const expectedPrefix = environment.ENVIRONMENT_ID === 'production' ? 'sk_live_' : 'sk_test_';
    if (!environment.STRIPE_SECRET_KEY.startsWith(expectedPrefix))
      throw new Error('Invalid environment configuration: Stripe key mode');
  }
  const buildVersion = environment.RAILWAY_ENVIRONMENT_NAME
    ? environment.RAILWAY_GIT_COMMIT_SHA
    : environment.BUILD_VERSION;
  if (!buildVersion)
    throw new Error(
      `Invalid environment configuration: ${environment.RAILWAY_ENVIRONMENT_NAME ? 'RAILWAY_GIT_COMMIT_SHA' : 'BUILD_VERSION'}`,
    );
  return { ...environment, BUILD_VERSION: buildVersion };
}
