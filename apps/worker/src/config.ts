import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  BUILD_VERSION: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._/-]+$/u),
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1),
  TRANSACTIONAL_EMAIL_PROVIDER: z.literal('postmark'),
  TRANSACTIONAL_EMAIL_TOKEN: z.string().min(1),
  TRANSACTIONAL_EMAIL_FROM: z.string().email(),
  PUBLIC_APPOINTMENT_TOKEN_SECRET: z.string().min(32),
});

export type WorkerEnvironment = z.infer<typeof environmentSchema>;

export function loadWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }

  return result.data;
}
