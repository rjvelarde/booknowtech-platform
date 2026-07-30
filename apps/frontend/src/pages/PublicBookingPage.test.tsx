import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicBookingPage } from './PublicBookingPage.js';

describe('PublicBookingPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('completes the read-only discovery flow without issuing a mutation', async () => {
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

    expect(screen.getByRole('status')).toHaveTextContent(
      'This selection has not been reserved or submitted',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) expect(init?.method ?? 'GET').toBe('GET');
    expect(screen.queryByText(/Any available provider/i)).not.toBeInTheDocument();
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
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
