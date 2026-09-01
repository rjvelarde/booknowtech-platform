import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicBookingPage } from './PublicBookingPage.js';

describe('PublicBookingPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/book');
  });

  it('reviews and creates a public appointment with an accessible confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            business: {
              public_id: 'tenant',
              name: 'Brazilian Wax Demo',
              description: 'Professional appointment services.',
              tagline: null,
              logo_url: null,
              primary_color: '#176CAB',
              website_url: null,
              phone: null,
              email: null,
            },
            timezone: 'America/New_York',
            locale: 'en-US',
            currency: 'USD',
            booking_terms: {
              version: 'test-v1',
              acknowledgment_label: 'I agree to the booking terms.',
              terms_url: null,
            },
            payment_checkout: {
              stripe_publishable_key: 'pk_test_synthetic',
              terms_version: 'payments-v2',
              terms_document_sha256: 'c'.repeat(64),
              terms_url: '/legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            items: [
              {
                public_id: 'wax',
                name: 'Brazilian Wax',
                description: null,
                delivery_mode: 'provider_location',
                duration_minutes: 30,
                base_price_minor: 5500,
                booking_fee_minor: 125,
                currency: 'USD',
                policy: { minimum_lead_minutes: 120, maximum_advance_days: 90 },
                payment_mode: 'fixed_deposit',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            service: { public_id: 'wax', name: 'Brazilian Wax' },
            items: [{ public_id: 'lisa', display_name: 'Lisa', bio: null, photo_url: null }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            timezone: 'America/New_York',
            items: [
              {
                starts_at: '2026-08-03T13:00:00.000Z',
                ends_at: '2026-08-03T13:30:00.000Z',
                local_start: '2026-08-03T09:00:00-04:00',
                timezone: 'America/New_York',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: {
            appointment_reference: 'BNT-PUBLIC01',
            status: 'scheduled',
            business: { name: 'Brazilian Wax Demo' },
            service: { name: 'Brazilian Wax', duration_minutes: 30 },
            provider: { display_name: 'Lisa', photo_url: null },
            starts_at: '2026-08-03T13:00:00.000Z',
            ends_at: '2026-08-03T13:30:00.000Z',
            local_start: '2026-08-03T09:00:00-04:00',
            timezone: 'America/New_York',
            location_mode: 'provider_location',
            replayed: false,
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<PublicBookingPage />);
    expect(await screen.findByRole('heading', { name: 'Brazilian Wax Demo' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Brazilian Wax/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lisa' }));
    fireEvent.change(screen.getByLabelText('Appointment date'), {
      target: { value: '2026-08-03' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '9:00 AM' }));

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Taylor' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'taylor@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Mobile phone'), {
      target: { value: '(843) 555-0104' },
    });
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    expect(screen.getByRole('link', { name: 'Payment Terms' })).toHaveAttribute(
      'href',
      '/legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md',
    );
    expect(checkboxes[1]!.closest('label')).toHaveTextContent(
      'I accept the Payment Terms, including the amount shown and the normally non-refundable online booking fee.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review appointment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to secure payment' }));

    expect(await screen.findByRole('heading', { name: 'You’re booked!' })).toBeInTheDocument();
    expect(screen.getByText(/BNT-PUBLIC01/)).toBeInTheDocument();
    expect(screen.getAllByText('✓ Selected')).toHaveLength(3);
    expect(screen.queryByText('Powered by BookNowTech')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      'Idempotency-Key': expect.any(String),
    });
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
      payment_terms: {
        version: 'payments-v2',
        document_sha256: 'c'.repeat(64),
        accepted: true,
      },
    });
    expect(screen.queryByText(/Any available provider/i)).not.toBeInTheDocument();
  });

  it('shows provider initials and a clear empty-time state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            business: {
              public_id: 'tenant',
              name: 'Brazilian Wax Demo',
              description: null,
              tagline: null,
              logo_url: null,
              primary_color: '#176CAB',
              website_url: null,
              phone: null,
              email: null,
            },
            timezone: 'America/New_York',
            locale: 'en-US',
            currency: 'USD',
            booking_terms: {
              version: 'test-v1',
              acknowledgment_label: 'I agree to the booking terms.',
              terms_url: null,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            items: [
              {
                public_id: 'wax',
                name: 'Brazilian Wax',
                description: null,
                delivery_mode: 'provider_location',
                duration_minutes: 30,
                base_price_minor: 5500,
                booking_fee_minor: 125,
                currency: 'USD',
                policy: { minimum_lead_minutes: 120, maximum_advance_days: 90 },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            service: { public_id: 'wax', name: 'Brazilian Wax' },
            items: [{ public_id: 'lisa', display_name: 'Lisa Jones', bio: null, photo_url: null }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { timezone: 'America/New_York', items: [] } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<PublicBookingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Brazilian Wax/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Lisa Jones/ }));
    expect(screen.getByText('LJ')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Appointment date'), {
      target: { value: '2026-08-03' },
    });
    expect(
      await screen.findByText('No appointments are available for this date.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Try another date or provider.')).toBeInTheDocument();
  });

  it('shows a safe unavailable page for a public 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: { code: 'public_business_not_found' } })),
    );
    render(<PublicBookingPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This booking page is not available',
    );
  });

  it('recovers a durable processing attempt from the route without browser-stored checkout state', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', `/book/checkout/${attemptId}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            business: {
              public_id: 'tenant',
              name: 'Paid Demo',
              description: null,
              tagline: null,
              logo_url: null,
              primary_color: '#176CAB',
              website_url: null,
              phone: null,
              email: null,
            },
            timezone: 'America/New_York',
            locale: 'en-US',
            currency: 'USD',
            booking_terms: {
              version: 'test-v1',
              acknowledgment_label: 'I agree.',
              terms_url: null,
            },
            payment_checkout: {
              stripe_publishable_key: 'pk_test_synthetic',
              terms_version: 'payments-v2',
              terms_document_sha256: 'b'.repeat(64),
              terms_url: '/legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md',
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { items: [] } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            appointment_reference: 'BNT-RECOVER',
            appointment_status: 'payment_pending',
            payment_attempt_public_id: attemptId,
            payment_status: 'processing',
            expires_at: '2026-08-25T19:00:00.000Z',
            client_secret: null,
            stripe_account: null,
            continuation_allowed: false,
            amounts: {
              service_price_minor: 10000,
              provider_amount_due_now_minor: 2500,
              booknowtech_fee_minor: 125,
              customer_total_due_now_minor: 2625,
              application_fee_amount_minor: 125,
              remaining_service_balance_minor: 7500,
              currency: 'USD',
            },
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<PublicBookingPage />);
    expect(await screen.findByRole('heading', { name: 'Payment is pending' })).toBeInTheDocument();
    expect(screen.getByText(/not confirmed/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/payment-attempts/${attemptId}`),
      expect.anything(),
    );
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
