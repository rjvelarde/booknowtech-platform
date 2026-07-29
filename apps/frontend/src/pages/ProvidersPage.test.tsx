import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from './ProvidersPage.js';

describe('provider service assignments', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('explains when every service is already assigned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/v1/admin/providers/provider-1')
          return Promise.resolve(response(200, { data: provider }));
        if (url === '/api/v1/admin/services')
          return Promise.resolve(response(200, { data: [service] }));
        return Promise.resolve(response(404, { error: { code: 'not_found' } }));
      }),
    );

    render(
      <ProvidersPage
        path="/providers/provider-1"
        csrfToken="csrf"
        canManage
        onNavigate={() => undefined}
      />,
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'All services are already assigned to this provider.',
    );
    expect(screen.queryByRole('combobox', { name: 'Service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign service' })).not.toBeInTheDocument();
  });
});

const service = {
  public_id: 'service-1',
  internal_code: 'WAX',
  name: 'Brazilian Wax',
  description: null,
  delivery_mode: 'provider_location' as const,
  duration_minutes: 30,
  base_price_minor: 5500,
  booking_fee_minor: 125,
  slot_cadence_minutes: null,
  currency: 'USD',
  status: 'active' as const,
  version: 1,
};

const provider = {
  public_id: 'provider-1',
  internal_code: 'LISA',
  display_name: 'Lisa',
  first_name: 'Lisa',
  last_name: null,
  email: null,
  phone: null,
  photo_url: null,
  bio: null,
  status: 'active' as const,
  customer_selectable: true,
  accepting_new_clients: true,
  display_order: 10,
  version: 1,
  service_assignments: [
    {
      public_id: 'assignment-1',
      status: 'active' as const,
      version: 1,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      provider: {
        public_id: 'provider-1',
        display_name: 'Lisa',
        status: 'active' as const,
        customer_selectable: true,
        accepting_new_clients: true,
      },
      service: { public_id: 'service-1', name: 'Brazilian Wax', status: 'active' as const },
      operationally_eligible: true,
    },
  ],
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
