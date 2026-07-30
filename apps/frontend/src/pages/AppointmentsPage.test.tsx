import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppointmentsPage } from './AppointmentsPage.js';

describe('AppointmentsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the immutable human-readable reference in the agenda', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: { items: [appointment()], next_cursor: null },
        }),
      ),
    );
    render(
      <AppointmentsPage
        path="/appointments"
        csrfToken="csrf"
        role="front_desk"
        onNavigate={vi.fn()}
      />,
    );
    expect(await screen.findByText('BNT-A1B2C3D4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maya Johnson' })).toBeInTheDocument();
    expect(screen.getByText(/Brazilian Wax with Lisa/)).toBeInTheDocument();
  });

  it('normalizes a partial appointment reference into an indexed prefix search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: { items: [], next_cursor: null },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AppointmentsPage
        path="/appointments"
        csrfToken="csrf"
        role="front_desk"
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Customer name or appointment reference'), {
      target: { value: 'a1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
        '/api/v1/admin/appointments?view=upcoming&reference=BNT-A1',
      ),
    );
  });

  it('searches active customers instead of loading a full dropdown', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/customers?'))
        return Promise.resolve(
          jsonResponse(200, {
            data: {
              items: [
                {
                  public_id: 'customer-a',
                  display_name: 'Maya Johnson',
                  email: 'maya@example.com',
                  mobile_phone: null,
                  status: 'active',
                  version: 1,
                },
              ],
              next_cursor: null,
            },
          }),
        );
      return Promise.resolve(jsonResponse(200, { data: { items: [] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AppointmentsPage
        path="/appointments/new"
        csrfToken="csrf"
        role="front_desk"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Customer' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Find customer' }), {
      target: { value: 'ma' },
    });
    expect(await screen.findByRole('option', { name: /Maya Johnson/ })).toHaveTextContent(
      'maya@example.com',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/customers?status=active&q=ma',
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('option', { name: /Maya Johnson/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected Maya Johnson');
  });

  it('shows progress and success feedback while rescheduling', async () => {
    let finishReschedule: ((response: Response) => void) | undefined;
    const pendingReschedule = new Promise<Response>((resolve) => {
      finishReschedule = resolve;
    });
    const updated = {
      ...appointment(),
      starts_at: '2027-02-03T16:00:00.000Z',
      ends_at: '2027-02-03T16:30:00.000Z',
      local_start_date: '2027-02-03',
      version: 2,
      changed: true,
    };
    const fetchMock = vi
      .fn()
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/scheduling-slots'))
          return Promise.resolve(
            jsonResponse(200, {
              data: { slots: [{ starts_at: updated.starts_at }] },
              meta: { next_cursor: null },
            }),
          );
        if (url.endsWith('/reschedule') && init?.method === 'POST') return pendingReschedule;
        return Promise.resolve(jsonResponse(200, { data: appointment() }));
      });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AppointmentsPage
        path="/appointments/appointment-a"
        csrfToken="csrf"
        role="tenant_owner"
        onNavigate={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { name: 'Maya Johnson' });
    fireEvent.change(screen.getByLabelText('New date'), { target: { value: '2027-02-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find available starts' }));
    fireEvent.click(await screen.findByRole('button', { name: /11:00 AM/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule appointment' }));
    expect(screen.getByRole('button', { name: 'Rescheduling…' })).toBeDisabled();
    finishReschedule?.(jsonResponse(200, { data: updated }));
    expect(await screen.findByRole('status')).toHaveTextContent('Appointment rescheduled to');
  });

  it('does not render lifecycle actions for a terminal appointment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: { ...appointment(), status: 'cancelled' },
        }),
      ),
    );
    render(
      <AppointmentsPage
        path="/appointments/appointment-a"
        csrfToken="csrf"
        role="tenant_owner"
        onNavigate={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Maya Johnson' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
  });
});

function appointment() {
  return {
    public_id: 'appointment-a',
    reference: 'BNT-A1B2C3D4',
    customer: { public_id: 'customer-a', display_name: 'Maya Johnson' },
    provider: { public_id: 'provider-a', display_name: 'Lisa' },
    service: { public_id: 'service-a', name: 'Brazilian Wax' },
    starts_at: '2027-02-02T15:00:00.000Z',
    ends_at: '2027-02-02T15:30:00.000Z',
    timezone: 'America/New_York',
    local_start_date: '2027-02-02',
    status: 'scheduled',
    version: 1,
    snapshot: {
      service_duration_minutes: 30,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      base_price_minor: 5500,
      booking_fee_minor: 125,
      currency: 'USD',
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
