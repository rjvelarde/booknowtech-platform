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

  it('adds the management CTA and plaintext URL only when supplied', () => {
    const url = 'https://tenant.booknowtech.com/appointments/manage/token#token=secret';
    const linked = renderAppointmentEmail('appointment_confirmation', 'BNT-ABC12345', data, url);
    const unlinked = renderAppointmentEmail('appointment_confirmation', 'BNT-ABC12345', data);
    expect(linked.html).toContain('Manage appointment');
    expect(linked.text).toContain(url);
    expect(unlinked.html).not.toContain('Manage appointment');
    expect(unlinked.text).not.toContain('/appointments/manage/');
  });

  it('uses the neutral online booking fee label in HTML and plaintext payment summaries', () => {
    const result = renderAppointmentEmail('appointment_confirmation', 'BNT-PAID0001', {
      ...data,
      currency: 'USD',
      service_price_minor: 5500,
      provider_amount_paid_online_minor: 2500,
      booknowtech_fee_minor: 125,
      remaining_service_balance_minor: 3000,
    });
    expect(result.html).toContain('Online booking fee: $1.25');
    expect(result.text).toContain('Online booking fee: $1.25');
    expect(result.html).not.toContain('BookNowTech booking fee');
    expect(result.text).not.toContain('BookNowTech booking fee');
    expect(result.html).not.toContain('Mobile Up Tech Inc.');
  });

  it('invites replies and includes configured public contact details', () => {
    const result = renderAppointmentEmail(
      'appointment_confirmation',
      'BNT-ABC12345',
      data,
      null,
      'appointments@example.com',
    );
    const wording =
      'Questions? Reply to this email or contact us at +18435551212 · hello@example.com · https://example.com.';
    expect(result.html).toContain(wording);
    expect(result.text).toContain(wording);
  });

  it('uses contact-only wording when replies are not configured', () => {
    const result = renderAppointmentEmail('appointment_confirmation', 'BNT-ABC12345', data);
    expect(result.text).toContain('Questions? Contact us at +18435551212');
    expect(result.text).not.toContain('Reply to this email');
  });

  it('omits contact guidance when neither replies nor public contact details are configured', () => {
    const result = renderAppointmentEmail('appointment_confirmation', 'BNT-ABC12345', {
      ...data,
      business_phone: null,
      business_email: null,
      business_website: null,
    });
    expect(result.html).not.toContain('Questions?');
    expect(result.text).not.toContain('Questions?');
  });
});
