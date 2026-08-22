import {
  type BookingRootDomain,
  PRODUCTION_BOOKING_ROOT_DOMAIN,
  STAGING_BOOKING_ROOT_DOMAIN,
  isAdministrativeHostname,
  normalizeHostname,
} from '@booknowtech/shared';
import { parse } from 'tldts';

export function validateCustomBookingHostname(
  input: string,
  bookingRootDomain: BookingRootDomain,
): string | null {
  const normalized = normalizeHostname(input);
  if (!normalized || input !== normalized || normalized.includes('*')) return null;
  if (
    [PRODUCTION_BOOKING_ROOT_DOMAIN, STAGING_BOOKING_ROOT_DOMAIN].some(
      (root) => normalized === root || normalized.endsWith(`.${root}`),
    )
  )
    return null;
  if (
    isAdministrativeHostname(normalized, bookingRootDomain) ||
    isAdministrativeHostname(normalized, PRODUCTION_BOOKING_ROOT_DOMAIN) ||
    isAdministrativeHostname(normalized, STAGING_BOOKING_ROOT_DOMAIN)
  )
    return null;
  const parsed = parse(normalized, { allowPrivateDomains: false });
  if (parsed.isIp || !parsed.publicSuffix || !parsed.domain || !parsed.subdomain) return null;
  return normalized;
}
