import { describe, expect, it } from 'vitest';
import { validateCustomBookingHostname } from './hostname.js';

describe('custom booking hostname validation', () => {
  it.each([
    ['booking.example.com', 'booking.example.com'],
    ['booking.example.co.uk', 'booking.example.co.uk'],
    ['xn--bcher-kva.customer.com', 'xn--bcher-kva.customer.com'],
    ['tenant.blogspot.com', 'tenant.blogspot.com'],
  ])('validates public-suffix-aware subdomains: %s', (input, expected) => {
    expect(validateCustomBookingHostname(input, 'staging.booknowtech.com')).toBe(expected);
  });

  it.each([
    'example.com',
    'example.co.uk',
    'booknowtech.com',
    'customer.booknowtech.com',
    'customer.staging.booknowtech.com',
    'admin.staging.booknowtech.com',
    '127.0.0.1',
    '[::1]',
    '*.example.com',
    'https://booking.example.com',
    'booking.example.com:443',
    'Booking.example.com',
    'booking..example.com',
    'bücher.customer.com',
    'xn--.customer.com',
  ])('rejects unsupported claim %s', (input) => {
    expect(validateCustomBookingHostname(input, 'staging.booknowtech.com')).toBeNull();
  });

  it('does not enable private-suffix apex handling', () => {
    expect(validateCustomBookingHostname('blogspot.com', 'staging.booknowtech.com')).toBeNull();
    expect(validateCustomBookingHostname('tenant.blogspot.com', 'staging.booknowtech.com')).toBe(
      'tenant.blogspot.com',
    );
  });
});
