import { z } from 'zod';

const publicEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.literal('/api'),
});

export type PublicEnvironment = z.infer<typeof publicEnvironmentSchema>;

export function loadPublicEnvironment(
  source: Record<string, unknown> = import.meta.env,
): PublicEnvironment {
  const result = publicEnvironmentSchema.safeParse(source);

  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid public environment configuration: ${names}`);
  }

  return result.data;
}
