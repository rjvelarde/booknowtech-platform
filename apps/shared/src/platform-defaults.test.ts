import { describe, expect, it } from 'vitest';

import { PLATFORM_TENANT_DEFAULTS } from './platform-defaults.js';

describe('platform tenant defaults', () => {
  it('freezes the accepted PR 3-12 safe defaults', () => {
    expect(PLATFORM_TENANT_DEFAULTS).toEqual({
      defaultSlotCadenceMinutes: 15,
      locale: 'en-US',
      publicBookingEnabled: false,
      publicProfile: {
        description: null,
        tagline: null,
        logoUrl: null,
        primaryColor: null,
        websiteUrl: null,
        phoneE164: null,
        emailNormalized: null,
      },
      bookingPolicy: {
        minimumLeadMinutes: 120,
        maximumAdvanceDays: 90,
      },
      publicBookingTerms: {
        version: '1',
        acknowledgmentLabel: 'I agree to the booking and cancellation terms.',
        termsUrl: null,
      },
      appointmentEmailSettings: {
        enabled: false,
        replyToEmail: null,
      },
      appointmentSelfService: {
        enabled: false,
        cancellationCutoffMinutes: 1_440,
        rescheduleCutoffMinutes: 1_440,
      },
    });
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS.publicProfile)).toBe(true);
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS.bookingPolicy)).toBe(true);
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS.publicBookingTerms)).toBe(true);
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS.appointmentEmailSettings)).toBe(true);
    expect(Object.isFrozen(PLATFORM_TENANT_DEFAULTS.appointmentSelfService)).toBe(true);
  });
});
