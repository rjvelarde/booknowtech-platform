import { describe, expect, it } from 'vitest';

import { renderAppointmentEmail } from './templates.js';

const data = {
  business_name: 'Brazilian Wax Demo',
  business_logo_url: 'https://example.com/logo.png',
  business_phone: '+18435551212',
  business_email: 'hello@example.com',
  business_website: 'https://example.com',
  customer_name: 'Avery & Co',
  provider_name: 'Lisa',
  provider_photo_url: null,
  service_name: 'Brazilian Wax',
  starts_at: new Date('2026-09-03T14:00:00.000Z'),
  ends_at: new Date('2026-09-03T14:30:00.000Z'),
  timezone: 'America/New_York',
  location_mode: 'provider_location' as const,
};

describe('renderAppointmentEmail', () => {
  it.each([
    ['appointment_confirmation', 'Your appointment is confirmed'],
    ['appointment_rescheduled', 'Your appointment has been rescheduled'],
    ['appointment_cancelled', 'Your appointment has been cancelled'],
  ] as const)('renders the shared branded layout for %s', (type, heading) => {
    const result = renderAppointmentEmail(type, 'BNT-ABC12345', data);
    expect(result.subject).toContain(heading);
    expect(result.html).toContain('logo.png');
    expect(result.html).toContain('BNT-ABC12345');
    expect(result.html).toContain('+18435551212');
    expect(result.html).toContain('Avery &amp; Co');
    expect(result.text).toContain('Brazilian Wax with Lisa');
  });
});
