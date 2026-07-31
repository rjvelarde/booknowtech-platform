import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServicesPage } from './ServicesPage.js';

describe('service editor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('scrolls to and focuses the editor heading when Edit is selected', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            data: [
              {
                public_id: 'service-1',
                internal_code: 'WAX',
                name: 'Brazilian Wax',
                description: null,
                delivery_mode: 'provider_location',
                duration_minutes: 30,
                base_price_minor: 5500,
                booking_fee_minor: 125,
                slot_cadence_minutes: null,
                currency: 'USD',
                status: 'active',
                publicly_bookable: false,
                public_display_order: 0,
                public_booking_policy: {
                  minimum_lead_minutes: null,
                  maximum_advance_days: null,
                },
                version: 1,
              },
            ],
          }),
        ),
      ),
    );

    render(<ServicesPage csrfToken="csrf" canManage onNavigate={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const heading = screen.getByRole('heading', { name: 'Edit Brazilian Wax' });
    expect(heading).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
