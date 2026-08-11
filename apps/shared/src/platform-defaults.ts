export const PLATFORM_TENANT_DEFAULTS = Object.freeze({
  defaultSlotCadenceMinutes: 15,
  locale: 'en-US',
  publicBookingEnabled: false,
  publicProfile: Object.freeze({
    description: null,
    tagline: null,
    logoUrl: null,
    primaryColor: null,
    websiteUrl: null,
    phoneE164: null,
    emailNormalized: null,
  }),
  bookingPolicy: Object.freeze({
    minimumLeadMinutes: 120,
    maximumAdvanceDays: 90,
  }),
  publicBookingTerms: Object.freeze({
    version: '1',
    acknowledgmentLabel: 'I agree to the booking and cancellation terms.',
    termsUrl: null,
  }),
  appointmentEmailSettings: Object.freeze({
    enabled: false,
    replyToEmail: null,
  }),
  appointmentSelfService: Object.freeze({
    enabled: false,
    cancellationCutoffMinutes: 1_440,
    rescheduleCutoffMinutes: 1_440,
  }),
} as const);

export type TenantDesignation = 'customer' | 'internal_qa';
