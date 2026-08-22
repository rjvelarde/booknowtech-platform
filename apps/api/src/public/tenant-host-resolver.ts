import type { BookingRootDomain } from '@booknowtech/shared';
import {
  fallbackBookingOrigin,
  fallbackTenantSlug,
  isAdministrativeHostname,
  normalizeHostname,
} from '@booknowtech/shared';

import type { AdminStore, BookingHostnameEnvironment, TenantDocument } from '../admin/store.js';

export type PublicTenantCapability = 'appointment_self_service' | 'public_booking';

type TenantHostStore = Pick<
  AdminStore,
  | 'getActiveCustomHostnameForTenant'
  | 'getActiveTenantBySlug'
  | 'getPublicTenantByCustomHostname'
  | 'getPublicTenantBySlug'
  | 'getSelfServiceTenantByCustomHostname'
>;

export class TenantHostResolver {
  public constructor(
    private readonly store: TenantHostStore,
    private readonly bookingRootDomain: BookingRootDomain = 'booknowtech.com',
    private readonly environment: BookingHostnameEnvironment = 'production',
  ) {}

  public async resolvePublicTenant(
    host: string,
    requiredCapability: PublicTenantCapability,
  ): Promise<TenantDocument | null> {
    const normalized = normalizeHostname(host);
    if (!normalized || isAdministrativeHostname(normalized, this.bookingRootDomain)) return null;
    const customTenant =
      requiredCapability === 'public_booking'
        ? await this.store.getPublicTenantByCustomHostname(normalized, this.environment)
        : await this.store.getSelfServiceTenantByCustomHostname(normalized, this.environment);
    if (customTenant && customHostnameAllowed(normalized, customTenant, this.bookingRootDomain))
      return customTenant;

    const slug = fallbackTenantSlug(normalized, this.bookingRootDomain);
    if (!slug) return null;

    if (requiredCapability === 'public_booking') {
      return await this.store.getPublicTenantBySlug(slug);
    }

    const tenant = await this.store.getActiveTenantBySlug(slug);
    return tenant?.appointment_self_service.enabled ? tenant : null;
  }

  public async publicBookingOrigin(
    tenant: Pick<TenantDocument, '_id' | 'public_id' | 'slug'>,
  ): Promise<string | null> {
    const customHostname = await this.store.getActiveCustomHostnameForTenant(
      tenant._id,
      tenant.public_id,
      this.environment,
    );
    const normalized = customHostname ? normalizeHostname(customHostname) : null;
    if (
      normalized &&
      normalized === customHostname &&
      !isAdministrativeHostname(normalized, this.bookingRootDomain) &&
      customHostnameAllowed(normalized, tenant, this.bookingRootDomain)
    )
      return `https://${normalized}`;
    return fallbackBookingOrigin(tenant.slug, this.bookingRootDomain);
  }
}

function customHostnameAllowed(
  normalizedHostname: string,
  tenant: Pick<TenantDocument, 'slug'>,
  bookingRootDomain: BookingRootDomain,
): boolean {
  const underPlatformRoot =
    normalizedHostname === bookingRootDomain ||
    normalizedHostname.endsWith(`.${bookingRootDomain}`);
  if (!underPlatformRoot) return true;
  return fallbackTenantSlug(normalizedHostname, bookingRootDomain) === tenant.slug;
}
