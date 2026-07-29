import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '../api/client.js';
import { AvailabilityPage } from './AvailabilityPage.js';

describe('scheduling start preview', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders customer time and discloses the complete blocked interval', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/admin/providers/lisa')
        return Promise.resolve(response(200, { data: provider() }));
      if (url.includes('/availability-schedule'))
        return Promise.resolve(
          response(404, { error: { code: 'availability_schedule_not_found' } }),
        );
      if (url.includes('/availability-exceptions'))
        return Promise.resolve(response(200, { data: [] }));
      if (url.includes('/scheduling-slots'))
        return Promise.resolve(
          response(200, {
            data: {
              eligible: true,
              timezone: 'America/New_York',
              booking_policy_enforced: false,
              service: {
                public_id: 'service',
                duration_minutes: 30,
                slot_cadence_minutes: 15,
              },
              assignment: {
                public_id: 'assignment',
                buffer_before_minutes: 5,
                buffer_after_minutes: 10,
              },
              slots: [
                {
                  starts_at: '2027-01-11T14:15:00.000Z',
                  service_ends_at: '2027-01-11T14:45:00.000Z',
                  blocked_starts_at: '2027-01-11T14:10:00.000Z',
                  blocked_ends_at: '2027-01-11T14:55:00.000Z',
                  local_start: '2027-01-11T09:15:00-05:00',
                  local_service_end: '2027-01-11T09:45:00-05:00',
                  local_blocked_start: '2027-01-11T09:10:00-05:00',
                  local_blocked_end: '2027-01-11T09:55:00-05:00',
                },
              ],
            },
            meta: { next_cursor: null },
          }),
        );
      return Promise.resolve(response(404, { error: { code: 'not_found' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AvailabilityPage
        providerId="lisa"
        csrfToken="csrf"
        canManage
        onNavigate={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Generate starts/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 theoretical start');
    expect(screen.getByText('2027-01-11 09:15-05:00')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Blocked-time details'));
    expect(screen.getByText(/09:10-05:00 through 2027-01-11 09:55-05:00/)).toBeInTheDocument();
  });
});

function provider(): ProviderView {
  return {
    public_id: 'lisa',
    internal_code: 'LISA',
    display_name: 'Lisa',
    first_name: 'Lisa',
    last_name: null,
    email: null,
    phone: null,
    photo_url: null,
    bio: null,
    status: 'active',
    customer_selectable: true,
    accepting_new_clients: true,
    display_order: 10,
    version: 1,
    service_assignments: [
      {
        public_id: 'assignment',
        status: 'active',
        version: 1,
        buffer_before_minutes: 5,
        buffer_after_minutes: 10,
        provider: {
          public_id: 'lisa',
          display_name: 'Lisa',
          status: 'active',
          customer_selectable: true,
          accepting_new_clients: true,
        },
        service: { public_id: 'service', name: 'Brazilian Wax', status: 'active' },
        operationally_eligible: true,
      },
    ],
  };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
