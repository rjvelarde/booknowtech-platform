import { randomUUID } from 'node:crypto';

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function resolveCorrelationId(value: string | string[] | undefined): string {
  if (typeof value === 'string' && correlationIdPattern.test(value)) {
    return value.toLowerCase();
  }

  return randomUUID();
}
