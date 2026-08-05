import { fallbackBookingOrigin, fallbackTenantSlug } from '@booknowtech/shared';

import type { AdminStore, TenantDocument } from '../admin/store.js';

export type PublicTenantCapability = 'appointment_self_service' | 'public_booking';

type TenantHostStore = Pick<AdminStore, 'getActiveTenantBySlug' | 'getPublicTenantBySlug'>;

export class TenantHostResolver {
  public constructor(private readonly store: TenantHostStore) {}

  public async resolvePublicTenant(
    host: string,
    requiredCapability: PublicTenantCapability,
  ): Promise<TenantDocument | null> {
    const slug = fallbackTenantSlug(host);
    if (!slug) return null;

    if (requiredCapability === 'public_booking') {
      return await this.store.getPublicTenantBySlug(slug);
    }

    const tenant = await this.store.getActiveTenantBySlug(slug);
    return tenant?.appointment_self_service.enabled ? tenant : null;
  }

  public publicBookingOrigin(tenant: Pick<TenantDocument, 'slug'>): string | null {
    return fallbackBookingOrigin(tenant.slug);
  }
}
