export {
  buildPublicAppointmentManagementUrl,
  derivePublicAppointmentCredential,
  hashPublicAppointmentCredential,
  verifyPublicAppointmentCredential,
} from './public-appointment-token.js';

export type {
  PublicAppointmentCredentialInput,
  PublicAppointmentCredentialPurpose,
} from './public-appointment-token.js';

export {
  type BookingRootDomain,
  fallbackBookingHostname,
  fallbackBookingOrigin,
  fallbackTenantSlug,
  isAdministrativeHostname,
  normalizeHostname,
  PRODUCTION_BOOKING_ROOT_DOMAIN,
  STAGING_BOOKING_ROOT_DOMAIN,
} from './hostname.js';

export { PLATFORM_TENANT_DEFAULTS } from './platform-defaults.js';
export type { TenantDesignation } from './platform-defaults.js';
