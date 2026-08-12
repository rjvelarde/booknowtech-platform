import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type TenantDesignation, fallbackBookingHostname } from '@booknowtech/shared';
import { z } from 'zod';

const nullableEmail = z
  .email()
  .max(320)
  .transform((value) => value.trim().toLowerCase())
  .nullable();

const provisioningInputSchema = z
  .object({
    business_name: z.string().trim().min(1).max(200),
    legal_name: z.string().trim().min(1).max(200).nullable().default(null),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    timezone: z.string().min(1).max(100).refine(isTimeZone, 'Invalid timezone'),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    designation: z.enum(['customer', 'internal_qa']).default('customer'),
    contact: z
      .object({
        email: nullableEmail.default(null),
        phone_e164: z
          .string()
          .regex(/^\+[1-9][0-9]{1,14}$/u)
          .nullable()
          .default(null),
        website_url: z.url().startsWith('https://').nullable().default(null),
      })
      .strict()
      .default({ email: null, phone_e164: null, website_url: null }),
    owner: z
      .object({
        display_name: z.string().trim().min(1).max(200),
        email: z
          .email()
          .max(320)
          .transform((value) => value.trim().toLowerCase()),
      })
      .strict(),
  })
  .strict();

export type ProvisioningInput = z.infer<typeof provisioningInputSchema>;

export interface ValidatedProvisioningInput extends ProvisioningInput {
  fallback_hostname: string;
  designation: TenantDesignation;
}

export async function readAndValidateProvisioningInput(
  path: string,
  rootDomain: 'booknowtech.com' | 'staging.booknowtech.com',
): Promise<ValidatedProvisioningInput> {
  const parsed = provisioningInputSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const fallbackHostname = fallbackBookingHostname(parsed.slug, rootDomain);
  if (!fallbackHostname) throw new Error('Invalid provisioning input: slug');
  return { ...parsed, fallback_hostname: fallbackHostname };
}

export function fingerprintProvisioningRequest(
  input: ValidatedProvisioningInput,
  authorization: { operatorId: string; reason: string },
): string {
  const canonical = {
    business_name: input.business_name,
    contact: input.contact,
    currency: input.currency,
    designation: input.designation,
    fallback_hostname: input.fallback_hostname,
    legal_name: input.legal_name,
    owner: input.owner,
    operator_id: authorization.operatorId,
    reason: authorization.reason,
    slug: input.slug,
    timezone: input.timezone,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
