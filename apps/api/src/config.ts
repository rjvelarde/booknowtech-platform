import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//u),
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
  BUILD_VERSION: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._/-]+$/u),
  ADMIN_ORIGIN: z.url(),
  TENANT_ADMIN_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  OPENAPI_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }

  if (result.data.NODE_ENV === 'production' && result.data.OPENAPI_ENABLED) {
    throw new Error('Invalid environment configuration: OPENAPI_ENABLED');
  }

  return result.data;
}
