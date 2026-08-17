import { z } from 'zod';
import type { BookingRootDomain } from '@booknowtech/shared';

const gitSha = /^[a-f0-9]{40}$/u;
const unsafeSecret = /^(?:change|replace|example|test-token|secret)/iu;

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  ENVIRONMENT_ID: z.enum(['development', 'test', 'staging', 'production']),
  RAILWAY_ENVIRONMENT_NAME: z.string().min(1).optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().regex(gitSha).optional(),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//u),
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
  BUILD_VERSION: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._/-]+$/u)
    .optional(),
  BOOKING_ROOT_DOMAIN: z.enum(['booknowtech.com', 'staging.booknowtech.com']),
  ADMIN_ORIGIN: z.url(),
  TENANT_ADMIN_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  OPENAPI_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  PUBLIC_APPOINTMENT_TOKEN_SECRET: z.string().min(32),
  RATE_LIMIT_KEY_SECRET: z.string().min(32),
  MONITORING_TOKEN: z.string().min(48).max(256),
});

type ParsedEnvironment = z.infer<typeof environmentSchema>;
export type Environment = Omit<ParsedEnvironment, 'BUILD_VERSION'> & {
  BUILD_VERSION: string;
  BOOKING_ROOT_DOMAIN: BookingRootDomain;
};

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }

  const environment = result.data;
  const invalid = validatePairing(environment);
  if (invalid) throw new Error(`Invalid environment configuration: ${invalid}`);

  if (environment.NODE_ENV === 'production' && environment.OPENAPI_ENABLED) {
    throw new Error('Invalid environment configuration: OPENAPI_ENABLED');
  }
  if (
    environment.NODE_ENV === 'production' &&
    ['ALLOW_DEVELOPMENT_SEED', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'].some(
      (name) => source[name] !== undefined,
    )
  )
    throw new Error('Invalid environment configuration: production seed variables');
  if (unsafeSecret.test(environment.PUBLIC_APPOINTMENT_TOKEN_SECRET))
    throw new Error('Invalid environment configuration: PUBLIC_APPOINTMENT_TOKEN_SECRET');
  if (unsafeSecret.test(environment.RATE_LIMIT_KEY_SECRET))
    throw new Error('Invalid environment configuration: RATE_LIMIT_KEY_SECRET');
  if (unsafeSecret.test(environment.MONITORING_TOKEN))
    throw new Error('Invalid environment configuration: MONITORING_TOKEN');
  if (environment.PUBLIC_APPOINTMENT_TOKEN_SECRET === environment.RATE_LIMIT_KEY_SECRET)
    throw new Error('Invalid environment configuration: environment-specific secrets');
  if (
    [environment.PUBLIC_APPOINTMENT_TOKEN_SECRET, environment.RATE_LIMIT_KEY_SECRET].includes(
      environment.MONITORING_TOKEN,
    )
  )
    throw new Error('Invalid environment configuration: MONITORING_TOKEN separation');
  if (
    ['staging', 'production'].includes(environment.ENVIRONMENT_ID) &&
    !environment.MONITORING_TOKEN.startsWith(`bnt_monitoring_${environment.ENVIRONMENT_ID}_`)
  )
    throw new Error('Invalid environment configuration: MONITORING_TOKEN environment');

  return {
    ...environment,
    BUILD_VERSION: buildVersion(environment),
  };
}

function validatePairing(environment: z.infer<typeof environmentSchema>): string | null {
  if (environment.NODE_ENV !== environment.ENVIRONMENT_ID) return 'NODE_ENV, ENVIRONMENT_ID';
  if (
    environment.RAILWAY_ENVIRONMENT_NAME &&
    environment.RAILWAY_ENVIRONMENT_NAME !== environment.ENVIRONMENT_ID
  )
    return 'RAILWAY_ENVIRONMENT_NAME, ENVIRONMENT_ID';
  const pairings: Partial<Record<ParsedEnvironment['ENVIRONMENT_ID'], [string, string]>> = {
    staging: ['booknowtech_staging', 'staging.booknowtech.com'],
    production: ['booknowtech_production', 'booknowtech.com'],
  };
  const required = pairings[environment.ENVIRONMENT_ID];
  if (required?.[0] !== undefined && environment.MONGODB_DATABASE !== required[0])
    return 'MONGODB_DATABASE, ENVIRONMENT_ID';
  if (required?.[1] !== undefined && environment.BOOKING_ROOT_DOMAIN !== required[1])
    return 'BOOKING_ROOT_DOMAIN, ENVIRONMENT_ID';
  return null;
}

function buildVersion(environment: z.infer<typeof environmentSchema>): string {
  if (environment.RAILWAY_ENVIRONMENT_NAME) {
    if (!environment.RAILWAY_GIT_COMMIT_SHA)
      throw new Error('Invalid environment configuration: RAILWAY_GIT_COMMIT_SHA');
    return environment.RAILWAY_GIT_COMMIT_SHA;
  }
  if (!environment.BUILD_VERSION)
    throw new Error('Invalid environment configuration: BUILD_VERSION');
  return environment.BUILD_VERSION;
}
