import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomersPage } from './CustomersPage.js';

describe('CustomersPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('searches and renders the tenant customer directory', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { items: [customer()], next_cursor: null } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomersPage path="/customers" csrfToken="csrf" onNavigate={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Maya Johnson' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'maya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/admin/customers?status=active&q=maya');
  });

  it('retains form values and requires explicit acknowledgement for a possible duplicate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'possible_duplicate',
            candidates: [
              {
                public_id: 'existing',
                display_name: 'Maya Johnson',
                email: 'maya@example.test',
                mobile_phone: null,
                status: 'active',
                reasons: ['email_exact'],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { data: customer() }));
    vi.stubGlobal('fetch', fetchMock);
    const navigate = vi.fn();
    render(<CustomersPage path="/customers/new" csrfToken="csrf" onNavigate={navigate} />);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Maya' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Johnson' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'maya@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save customer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Possible duplicate customer');
    expect(screen.getByLabelText('First name')).toHaveValue('Maya');
    fireEvent.click(screen.getByRole('button', { name: 'Create separate customer' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/customers/customer-a'));
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.acknowledge_possible_duplicate).toBe(true);
  });

  it('shows reserved future tabs as disabled on customer detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: customer() })));
    render(<CustomersPage path="/customers/customer-a" csrfToken="csrf" onNavigate={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Maya Johnson' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appointments' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Payments' })).toBeDisabled();
  });
});

function customer() {
  return {
    public_id: 'customer-a',
    display_name: 'Maya Johnson',
    first_name: 'Maya',
    last_name: 'Johnson',
    preferred_name: null,
    email: 'maya@example.test',
    mobile_phone: null,
    addresses: [],
    communication_preferences: {
      preferred_channel: 'email',
      marketing_email: 'unknown',
      marketing_sms: 'unknown',
    },
    source: 'manual',
    status: 'active',
    version: 1,
    updated_at: '2026-07-29T12:00:00.000Z',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
