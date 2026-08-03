import { describe, expect, it } from 'vitest';

import {
  buildPublicAppointmentManagementUrl,
  derivePublicAppointmentCredential,
  hashPublicAppointmentCredential,
  verifyPublicAppointmentCredential,
} from './public-appointment-token.js';

const secret = 'test-secret-that-is-at-least-thirty-two-bytes-long';
const input = {
  version: 1 as const,
  tokenPublicId: 'token-public-id',
  appointmentPublicId: 'appointment-public-id',
  generation: 1,
  purpose: 'appointment_management' as const,
};

describe('public appointment credentials', () => {
  it('derives deterministic, context-bound credentials', () => {
    const credential = derivePublicAppointmentCredential(secret, input);

    expect(credential).toBe(derivePublicAppointmentCredential(secret, input));
    expect(credential).not.toBe(
      derivePublicAppointmentCredential(secret, { ...input, generation: 2 }),
    );
  });

  it('verifies only the matching credential hash', () => {
    const credential = derivePublicAppointmentCredential(secret, input);
    const hash = hashPublicAppointmentCredential(credential);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    expect(verifyPublicAppointmentCredential(credential, hash)).toBe(true);
    expect(verifyPublicAppointmentCredential(`${credential}x`, hash)).toBe(false);
    expect(verifyPublicAppointmentCredential('', hash)).toBe(false);
  });

  it('rejects weak secrets and invalid generations', () => {
    expect(() => derivePublicAppointmentCredential('short', input)).toThrow(/32 bytes/);
    expect(() => derivePublicAppointmentCredential(secret, { ...input, generation: 0 })).toThrow(
      /positive safe integer/,
    );
  });

  it('places the credential only in the URL fragment', () => {
    const url = buildPublicAppointmentManagementUrl(
      'https://tenant.booknowtech.com',
      'token id',
      'credential/value',
    );

    expect(url).toBe(
      'https://tenant.booknowtech.com/appointments/manage/token%20id#token=credential%2Fvalue',
    );
    expect(new URL(url).search).toBe('');
  });
});
