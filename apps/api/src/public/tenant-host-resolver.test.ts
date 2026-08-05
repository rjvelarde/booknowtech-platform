import { describe, expect, it, vi } from 'vitest';

import type { AdminStore, TenantDocument } from '../admin/store.js';
import { TenantHostResolver } from './tenant-host-resolver.js';

const publishedTenant = {
  slug: 'published',
  status: 'active',
  public_booking_enabled: true,
  appointment_self_service: { enabled: true },
} as TenantDocument;

describe('TenantHostResolver', () => {
  it.each([
    ['published.booknowtech.com', 'published'],
    ['PUBLISHED.booknowtech.com.', 'published'],
    ['published.localhost:8080', 'published'],
    ['published.example.test:4173', 'published'],
  ])('resolves current fallback booking host %s', async (host, slug) => {
    const store = storeFixture();
    store.getPublicTenantBySlug.mockResolvedValue(publishedTenant);

    await expect(resolver(store).resolvePublicTenant(host, 'public_booking')).resolves.toBe(
      publishedTenant,
    );
    expect(store.getPublicTenantBySlug).toHaveBeenCalledWith(slug);
  });

  it.each([
    'admin.booknowtech.com',
    'booknowtech.com',
    'published.attacker.booknowtech.com',
    'published.booknowtech.com.attacker.test',
    'published_booknowtech.com',
  ])('returns null without a lookup for invalid host %s', async (host) => {
    const store = storeFixture();

    await expect(resolver(store).resolvePublicTenant(host, 'public_booking')).resolves.toBeNull();
    expect(store.getPublicTenantBySlug).not.toHaveBeenCalled();
    expect(store.getActiveTenantBySlug).not.toHaveBeenCalled();
  });

  it('preserves unpublished, nonexistent, and inactive tenant rejection', async () => {
    const store = storeFixture();
    store.getPublicTenantBySlug.mockResolvedValue(null);

    await expect(
      resolver(store).resolvePublicTenant('unpublished.booknowtech.com', 'public_booking'),
    ).resolves.toBeNull();
    await expect(
      resolver(store).resolvePublicTenant('nonexistent.booknowtech.com', 'public_booking'),
    ).resolves.toBeNull();
    await expect(
      resolver(store).resolvePublicTenant('inactive.booknowtech.com', 'public_booking'),
    ).resolves.toBeNull();
  });

  it('requires active tenant self-service capability for management hosts', async () => {
    const store = storeFixture();
    store.getActiveTenantBySlug.mockResolvedValueOnce(publishedTenant).mockResolvedValueOnce({
      ...publishedTenant,
      appointment_self_service: {
        ...publishedTenant.appointment_self_service,
        enabled: false,
      },
    });
    const hostResolver = resolver(store);

    await expect(
      hostResolver.resolvePublicTenant('published.booknowtech.com', 'appointment_self_service'),
    ).resolves.toBe(publishedTenant);
    await expect(
      hostResolver.resolvePublicTenant('published.booknowtech.com', 'appointment_self_service'),
    ).resolves.toBeNull();
  });

  it('exposes the fallback origin as the PR 13 extension point', () => {
    expect(resolver(storeFixture()).publicBookingOrigin(publishedTenant)).toBe(
      'https://published.booknowtech.com',
    );
  });
});

function resolver(store: ReturnType<typeof storeFixture>) {
  return new TenantHostResolver(store);
}

function storeFixture() {
  return {
    getPublicTenantBySlug: vi.fn<AdminStore['getPublicTenantBySlug']>(),
    getActiveTenantBySlug: vi.fn<AdminStore['getActiveTenantBySlug']>(),
  };
}
