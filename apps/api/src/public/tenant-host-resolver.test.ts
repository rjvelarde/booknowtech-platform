import { describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';

import type { AdminStore, TenantDocument } from '../admin/store.js';
import { TenantHostResolver } from './tenant-host-resolver.js';

const publishedTenant = {
  _id: new ObjectId(),
  public_id: '11111111-1111-4111-8111-111111111111',
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

  it('keeps the administrative hostname outside custom-host resolution', async () => {
    const store = storeFixture();
    await expect(
      resolver(store).resolvePublicTenant('admin.booknowtech.com', 'public_booking'),
    ).resolves.toBeNull();
    expect(store.getPublicTenantByCustomHostname).not.toHaveBeenCalled();
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

  it('uses an active custom hostname as the preferred origin', async () => {
    const store = storeFixture();
    store.getActiveCustomHostnameForTenant.mockResolvedValue('book.customer-domain.com');
    await expect(resolver(store).publicBookingOrigin(publishedTenant)).resolves.toBe(
      'https://book.customer-domain.com',
    );
  });

  it('falls back when no active custom hostname exists', async () => {
    await expect(resolver(storeFixture()).publicBookingOrigin(publishedTenant)).resolves.toBe(
      'https://published.booknowtech.com',
    );
  });

  it.each([
    'ADMIN.booknowtech.com',
    'admin.booknowtech.com',
    'other-tenant.booknowtech.com',
    'https://book.customer-domain.com',
    'book.customer-domain.com.',
  ])('falls back from unsafe persisted preferred hostname %s', async (hostname) => {
    const store = storeFixture();
    store.getActiveCustomHostnameForTenant.mockResolvedValue(hostname);
    await expect(resolver(store).publicBookingOrigin(publishedTenant)).resolves.toBe(
      'https://published.booknowtech.com',
    );
  });

  it('does not let a custom record override another tenant fallback hostname', async () => {
    const store = storeFixture();
    store.getPublicTenantByCustomHostname.mockResolvedValue(publishedTenant);
    const otherTenant = { ...publishedTenant, slug: 'other-tenant' };
    store.getPublicTenantBySlug.mockResolvedValue(otherTenant);
    await expect(
      resolver(store).resolvePublicTenant('other-tenant.booknowtech.com', 'public_booking'),
    ).resolves.toBe(otherTenant);
  });

  it('resolves an active custom hostname before fallback parsing', async () => {
    const store = storeFixture();
    store.getPublicTenantByCustomHostname.mockResolvedValue(publishedTenant);
    await expect(
      resolver(store).resolvePublicTenant('BOOK.customer-domain.com.', 'public_booking'),
    ).resolves.toBe(publishedTenant);
    expect(store.getPublicTenantByCustomHostname).toHaveBeenCalledWith(
      'book.customer-domain.com',
      'production',
    );
    expect(store.getPublicTenantBySlug).not.toHaveBeenCalled();
  });

  it('does not resolve a non-active or unknown custom hostname', async () => {
    const store = storeFixture();
    store.getPublicTenantByCustomHostname.mockResolvedValue(null);
    await expect(
      resolver(store).resolvePublicTenant('pending.customer-domain.com', 'public_booking'),
    ).resolves.toBeNull();
  });

  it('resolves only the configured staging suffix', async () => {
    const store = storeFixture();
    store.getPublicTenantBySlug.mockResolvedValue(publishedTenant);
    const stagingResolver = new TenantHostResolver(store, 'staging.booknowtech.com', 'staging');
    await expect(
      stagingResolver.resolvePublicTenant('published.staging.booknowtech.com', 'public_booking'),
    ).resolves.toBe(publishedTenant);
    await expect(
      stagingResolver.resolvePublicTenant('published.booknowtech.com', 'public_booking'),
    ).resolves.toBeNull();
    await expect(stagingResolver.publicBookingOrigin(publishedTenant)).resolves.toBe(
      'https://published.staging.booknowtech.com',
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
    getPublicTenantByCustomHostname: vi.fn<AdminStore['getPublicTenantByCustomHostname']>(),
    getSelfServiceTenantByCustomHostname:
      vi.fn<AdminStore['getSelfServiceTenantByCustomHostname']>(),
    getActiveCustomHostnameForTenant: vi.fn<AdminStore['getActiveCustomHostnameForTenant']>(),
  };
}
