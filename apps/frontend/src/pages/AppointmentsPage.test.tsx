import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    customer: { display_name: 'Maya Johnson' },
    provider: { display_name: 'Lisa' },
    service: { name: 'Brazilian Wax' },
    starts_at: '2027-02-02T15:00:00.000Z',
    ends_at: '2027-02-02T15:30:00.000Z',
    timezone: 'America/New_York',
    local_start_date: '2027-02-02',
    status: 'scheduled',
    version: 1,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
