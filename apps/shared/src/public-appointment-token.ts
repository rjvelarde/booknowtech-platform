import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type PublicAppointmentCredentialPurpose = 'appointment_management';

export interface PublicAppointmentCredentialInput {
  version: 1;
  tokenPublicId: string;
  appointmentPublicId: string;
  generation: number;
  purpose: PublicAppointmentCredentialPurpose;
}

function assertNonempty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function canonicalize(input: PublicAppointmentCredentialInput): string {
  assertNonempty(input.tokenPublicId, 'tokenPublicId');
  assertNonempty(input.appointmentPublicId, 'appointmentPublicId');

  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('generation must be a positive safe integer');
  }

  return JSON.stringify([
    input.version,
    input.tokenPublicId,
    input.appointmentPublicId,
    input.generation,
    input.purpose,
  ]);
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('PUBLIC_APPOINTMENT_TOKEN_SECRET must contain at least 32 bytes');
  }
}

export function derivePublicAppointmentCredential(
  secret: string,
  input: PublicAppointmentCredentialInput,
): string {
  assertSecret(secret);

  return createHmac('sha256', secret).update(canonicalize(input), 'utf8').digest('base64url');
}

export function hashPublicAppointmentCredential(rawCredential: string): string {
  assertNonempty(rawCredential, 'rawCredential');
  return createHash('sha256').update(rawCredential, 'utf8').digest('hex');
}

export function verifyPublicAppointmentCredential(
  rawCredential: string,
  expectedHash: string,
): boolean {
  if (rawCredential.length === 0 || expectedHash.length === 0) {
    return false;
  }

  const actual = Buffer.from(hashPublicAppointmentCredential(rawCredential), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildPublicAppointmentManagementUrl(
  publicOrigin: string,
  tokenPublicId: string,
  rawCredential: string,
): string {
  assertNonempty(tokenPublicId, 'tokenPublicId');
  assertNonempty(rawCredential, 'rawCredential');

  const url = new URL(`/appointments/manage/${encodeURIComponent(tokenPublicId)}`, publicOrigin);
  url.hash = `token=${encodeURIComponent(rawCredential)}`;
  return url.toString();
}
