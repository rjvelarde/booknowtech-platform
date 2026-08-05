import { describe, expect, it } from 'vitest';

import {
  fallbackBookingHostname,
  fallbackBookingOrigin,
  fallbackTenantSlug,
  isAdministrativeHostname,
  normalizeHostname,
} from './hostname.js';

describe('canonical fallback hostname model', () => {
  it.each([
    ['Tenant-Slug.BookNowTech.com', 'tenant-slug.booknowtech.com'],
    ['tenant-slug.booknowtech.com.', 'tenant-slug.booknowtech.com'],
    ['tenant.localhost:8080', 'tenant.localhost'],
    ['tenant.example.test:4173', 'tenant.example.test'],
    ['xn--bcher-kva.booknowtech.com', 'xn--bcher-kva.booknowtech.com'],
    ['bücher.booknowtech.com', 'xn--bcher-kva.booknowtech.com'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    '',
    ' tenant.booknowtech.com',
    'tenant.booknowtech.com ',
    'tenant booknowtech.com',
    'tenant\n.booknowtech.com',
    'https://tenant.booknowtech.com',
    'tenant.booknowtech.com/path',
    'user@tenant.booknowtech.com',
    'tenant.booknowtech.com?query',
    'tenant.booknowtech.com#fragment',
    'tenant..booknowtech.com',
    '_tenant.booknowtech.com',
    '-tenant.booknowtech.com',
    'tenant-.booknowtech.com',
    'tenant.booknowtech.com..',
    'tenant.booknowtech.com:443',
    'tenant.localhost:0',
    'tenant.localhost:65536',
    `${'a'.repeat(64)}.booknowtech.com`,
    `${Array.from({ length: 128 }, () => 'a').join('.')}.booknowtech.com`,
  ])('rejects malformed hostname %s', (input) => {
    expect(normalizeHostname(input)).toBeNull();
  });

  it.each([
    ['tenant-slug.booknowtech.com', 'tenant-slug'],
    ['TENANT-SLUG.booknowtech.com.', 'tenant-slug'],
    ['tenant-slug.localhost:8080', 'tenant-slug'],
    ['tenant-slug.example.test:4173', 'tenant-slug'],
    ['xn--bcher-kva.booknowtech.com', 'xn--bcher-kva'],
  ])('extracts exactly one fallback tenant label from %s', (hostname, slug) => {
    expect(fallbackTenantSlug(hostname)).toBe(slug);
  });

  it.each([
    'booknowtech.com',
    'www.booknowtech.com',
    'admin.booknowtech.com',
    'api.booknowtech.com',
    'book.booknowtech.com',
    'support.booknowtech.com',
    'status.booknowtech.com',
    'tenant.attacker.booknowtech.com',
    'tenant.booknowtech.com.attacker.test',
    'tenant.example.com',
    'tenant.localhost.attacker.test',
  ])('does not resolve unsupported or reserved host %s', (hostname) => {
    expect(fallbackTenantSlug(hostname)).toBeNull();
  });

  it('generates the canonical production fallback hostname and origin', () => {
    expect(fallbackBookingHostname('Tenant-Slug')).toBe('tenant-slug.booknowtech.com');
    expect(fallbackBookingOrigin('Tenant-Slug')).toBe('https://tenant-slug.booknowtech.com');
    expect(fallbackBookingHostname('admin')).toBeNull();
    expect(fallbackBookingOrigin('nested.slug')).toBeNull();
  });

  it('isolates staging and production fallback hosts', () => {
    expect(fallbackTenantSlug('tenant.staging.booknowtech.com', 'staging.booknowtech.com')).toBe(
      'tenant',
    );
    expect(fallbackTenantSlug('tenant.booknowtech.com', 'staging.booknowtech.com')).toBeNull();
    expect(fallbackTenantSlug('tenant.staging.booknowtech.com', 'booknowtech.com')).toBeNull();
    expect(fallbackBookingHostname('Tenant', 'staging.booknowtech.com')).toBe(
      'tenant.staging.booknowtech.com',
    );
    expect(fallbackBookingOrigin('Tenant', 'staging.booknowtech.com')).toBe(
      'https://tenant.staging.booknowtech.com',
    );
    expect(
      isAdministrativeHostname('admin.staging.booknowtech.com', 'staging.booknowtech.com'),
    ).toBe(true);
    expect(isAdministrativeHostname('admin.booknowtech.com', 'staging.booknowtech.com')).toBe(
      false,
    );
  });

  it.each([
    ['admin.booknowtech.com', true],
    ['ADMIN.booknowtech.com.', true],
    ['admin.example.test:4173', true],
    ['admin.localhost:8080', true],
    ['localhost:5173', true],
    ['tenant.booknowtech.com', false],
    ['booknowtech.com', false],
    ['www.booknowtech.com', false],
    ['admin.booknowtech.com.attacker.test', false],
  ])('classifies administrative hostname %s', (hostname, expected) => {
    expect(isAdministrativeHostname(hostname)).toBe(expected);
  });
});
