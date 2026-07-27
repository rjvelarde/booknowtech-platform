import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

describe('Business Hub', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('preserves the launch placeholder while the rollout flag is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(404, { error: { code: 'not_found' } })),
    );
    render(<App />);

    expect(
      await screen.findByText('The Business Hub is being prepared for launch.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows login after an unauthenticated session response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'authentication_required' } })),
    );
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
  });

  it('renders the selected tenant after login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'authentication_required' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            user: { public_id: 'user', display_name: 'Owner' },
            active_tenant: {
              public_id: 'tenant',
              display_name: 'Harbor Demo',
              role: 'tenant_owner',
            },
            memberships: [
              {
                public_id: 'membership',
                role: 'tenant_owner',
                tenant: { public_id: 'tenant', display_name: 'Harbor Demo' },
              },
            ],
            csrf_token: 'csrf',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Harbor Demo' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/login');
  });

  it('signs out without declaring an empty JSON body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: activeSession() }))
      .mockResolvedValueOnce(jsonResponse(204, null));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    const logoutRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(logoutRequest.body).toBeUndefined();
    expect(logoutRequest.headers).not.toHaveProperty('content-type');
  });

  it('keeps the authenticated shell visible when sign out fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: activeSession() }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'internal_error' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign out');
    expect(screen.getByRole('heading', { name: 'Harbor Demo' })).toBeInTheDocument();
  });

  it('shows the tenant service catalog and hides management controls from providers', async () => {
    const providerSession = {
      ...activeSession(),
      active_tenant: { ...activeSession().active_tenant, role: 'provider' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: providerSession }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              public_id: 'service',
              internal_code: 'BRAZILIAN-WAX',
              name: 'Brazilian Wax',
              description: null,
              delivery_mode: 'provider_location',
              duration_minutes: 30,
              base_price_minor: 5500,
              booking_fee_minor: 125,
              currency: 'USD',
              status: 'active',
              version: 1,
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Services' }));

    expect(await screen.findByRole('heading', { name: 'Brazilian Wax' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add service' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/admin/services');
  });

  it('edits and submits business profile fields', async () => {
    const profile = {
      public_id: 'tenant',
      slug: 'brazilian-wax-demo',
      display_name: 'Brazilian Wax Demo',
      legal_name: null,
      contact: { email: null, phone: null, website: null },
      default_timezone: 'America/New_York',
      locale: 'en-US',
      currency: 'USD',
      version: 1,
      updated_at: '2026-07-27T12:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: activeSession() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: profile }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { ...profile, legal_name: 'Brazilian Wax Demo LLC', version: 2 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Business profile' }));
    const legalName = await screen.findByLabelText('Legal name');

    fireEvent.change(legalName, { target: { value: 'Brazilian Wax Demo LLC' } });
    expect(legalName).toHaveValue('Brazilian Wax Demo LLC');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Business profile saved');
    const request = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(typeof request.body).toBe('string');
    expect(JSON.parse(request.body as string)).toMatchObject({
      expected_version: 1,
      legal_name: 'Brazilian Wax Demo LLC',
    });
  });

  it('shows providers to staff while reserving provider management for owners and admins', async () => {
    const providerSession = {
      ...activeSession(),
      active_tenant: { ...activeSession().active_tenant, role: 'front_desk' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: providerSession }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            items: [
              {
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
              },
            ],
            next_cursor: null,
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Providers' }));

    expect(await screen.findByRole('heading', { name: 'Lisa' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/admin/providers');
  });

  it('opens the new provider form without treating new as a provider public ID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: activeSession() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { items: [], next_cursor: null } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Providers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));

    expect(screen.getByRole('heading', { name: 'Add provider' })).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/admin/services');
  });
});

function activeSession() {
  return {
    user: { public_id: 'user', display_name: 'Owner' },
    active_tenant: {
      public_id: 'tenant',
      display_name: 'Harbor Demo',
      role: 'tenant_owner',
    },
    memberships: [
      {
        public_id: 'membership',
        role: 'tenant_owner',
        tenant: { public_id: 'tenant', display_name: 'Harbor Demo' },
      },
    ],
    csrf_token: 'csrf',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
