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
  STRIPE_SECRET_KEY: z.string().min(16).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().min(16).optional(),
  STRIPE_PLATFORM_WEBHOOK_SECRET: z.string().min(16).optional(),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(16).optional(),
  STRIPE_CONNECT_COUNTRY: z.literal('US').default('US'),
  BOOKNOWTECH_CONNECT_TERMS_VERSION: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
    .optional(),
  BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  STRIPE_PAYMENTS_FOUNDATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  STRIPE_PAYMENT_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400).optional(),
  BOOKNOWTECH_PAYMENT_TERMS_VERSION: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
    .optional(),
  BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  PAYMENT_IP_HASH_SECRET: z.string().min(32).optional(),
  CHECKOUT_RECOVERY_TOKEN_SECRET: z.string().min(32).optional(),
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
  if (environment.PAYMENT_IP_HASH_SECRET && unsafeSecret.test(environment.PAYMENT_IP_HASH_SECRET))
    throw new Error('Invalid environment configuration: PAYMENT_IP_HASH_SECRET');
  if (
    environment.CHECKOUT_RECOVERY_TOKEN_SECRET &&
    unsafeSecret.test(environment.CHECKOUT_RECOVERY_TOKEN_SECRET)
  )
    throw new Error('Invalid environment configuration: CHECKOUT_RECOVERY_TOKEN_SECRET');
  if (environment.PUBLIC_APPOINTMENT_TOKEN_SECRET === environment.RATE_LIMIT_KEY_SECRET)
    throw new Error('Invalid environment configuration: environment-specific secrets');
  if (
    [environment.PUBLIC_APPOINTMENT_TOKEN_SECRET, environment.RATE_LIMIT_KEY_SECRET].includes(
      environment.MONITORING_TOKEN,
    )
  )
    throw new Error('Invalid environment configuration: MONITORING_TOKEN separation');
  if (
    environment.PAYMENT_IP_HASH_SECRET &&
    [
      environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
      environment.RATE_LIMIT_KEY_SECRET,
      environment.MONITORING_TOKEN,
    ].includes(environment.PAYMENT_IP_HASH_SECRET)
  )
    throw new Error('Invalid environment configuration: PAYMENT_IP_HASH_SECRET separation');
  if (
    environment.CHECKOUT_RECOVERY_TOKEN_SECRET &&
    [
      environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
      environment.RATE_LIMIT_KEY_SECRET,
      environment.MONITORING_TOKEN,
      environment.PAYMENT_IP_HASH_SECRET,
    ].includes(environment.CHECKOUT_RECOVERY_TOKEN_SECRET)
  )
    throw new Error('Invalid environment configuration: CHECKOUT_RECOVERY_TOKEN_SECRET separation');
  if (
    ['staging', 'production'].includes(environment.ENVIRONMENT_ID) &&
    !environment.MONITORING_TOKEN.startsWith(`bnt_monitoring_${environment.ENVIRONMENT_ID}_`)
  )
    throw new Error('Invalid environment configuration: MONITORING_TOKEN environment');
  validateStripeConfiguration(environment);
  validatePaymentExecutionConfiguration(environment);

  return {
    ...environment,
    BUILD_VERSION: buildVersion(environment),
  };
}

function validatePaymentExecutionConfiguration(
  environment: z.infer<typeof environmentSchema>,
): void {
  if (!environment.STRIPE_PAYMENT_EXECUTION_ENABLED) return;
  if (!environment.STRIPE_PAYMENTS_FOUNDATION_ENABLED)
    throw new Error('Invalid environment configuration: STRIPE_PAYMENTS_FOUNDATION_ENABLED');
  for (const name of [
    'STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS',
    'BOOKNOWTECH_PAYMENT_TERMS_VERSION',
    'BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256',
    'PAYMENT_IP_HASH_SECRET',
    'STRIPE_PUBLISHABLE_KEY',
    'CHECKOUT_RECOVERY_TOKEN_SECRET',
  ] as const)
    if (environment[name] === undefined)
      throw new Error(`Invalid environment configuration: ${name}`);
}

function validateStripeConfiguration(environment: z.infer<typeof environmentSchema>): void {
  const values = [
    environment.STRIPE_SECRET_KEY,
    environment.STRIPE_PLATFORM_WEBHOOK_SECRET,
    environment.STRIPE_CONNECT_WEBHOOK_SECRET,
    environment.BOOKNOWTECH_CONNECT_TERMS_VERSION,
    environment.BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256,
  ];
  const configured = values.filter((value) => value !== undefined).length;
  if (configured !== 0 && configured !== values.length)
    throw new Error('Invalid environment configuration: incomplete Stripe Connect configuration');
  if (environment.STRIPE_PAYMENTS_FOUNDATION_ENABLED && configured === 0)
    throw new Error('Invalid environment configuration: Stripe Connect configuration');
  if (configured === 0) return;
  const live = environment.STRIPE_SECRET_KEY!.startsWith('sk_live_');
  const test = environment.STRIPE_SECRET_KEY!.startsWith('sk_test_');
  if (environment.STRIPE_PUBLISHABLE_KEY) {
    const publishableLive = environment.STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_');
    const publishableTest = environment.STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_');
    if ((!publishableLive && !publishableTest) || publishableLive !== live)
      throw new Error('Invalid environment configuration: STRIPE_PUBLISHABLE_KEY');
  }
  if (environment.STRIPE_PLATFORM_WEBHOOK_SECRET === environment.STRIPE_CONNECT_WEBHOOK_SECRET)
    throw new Error('Invalid environment configuration: Stripe webhook secret separation');
  if ((!live && !test) || (environment.ENVIRONMENT_ID === 'production' ? !live : !test))
    throw new Error('Invalid environment configuration: Stripe key mode');
  if (
    !environment.STRIPE_PLATFORM_WEBHOOK_SECRET!.startsWith('whsec_') ||
    !environment.STRIPE_CONNECT_WEBHOOK_SECRET!.startsWith('whsec_')
  )
    throw new Error('Invalid environment configuration: Stripe webhook secrets');
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
