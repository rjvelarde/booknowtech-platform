import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PublicAppointmentManagementPage,
  captureManagementCredential,
  formatTimezone,
} from './PublicAppointmentManagementPage.js';

const tokenId = '11111111-1111-4111-8111-111111111111';
const replacementId = '22222222-2222-4222-8222-222222222222';
const credential = 'raw_initial_credential';
const replacementCredential = 'raw_replacement_credential';

describe('public appointment management', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', `/appointments/manage/${tokenId}#token=${credential}`);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('captures the fragment once, removes it, and never uses browser storage', () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const captured = captureManagementCredential(window.location, window.history);
    expect(captured).toEqual({ tokenPublicId: tokenId, credential });
    expect(window.location.hash).toBe('');
    expect(localSet).not.toHaveBeenCalled();
  });

  it('shows the branded safe summary, eligibility, and cutoff messaging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { data: managedAppointment() })),
    );
    render(<PublicAppointmentManagementPage />);
    const heading = await screen.findByRole('heading', { name: 'Harbor Service' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Safe Business')).toBeInTheDocument();
    expect(screen.getByText('BNT-12345678')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeEnabled();
    expect(screen.getByText(/Rescheduling is available until/)).toBeInTheDocument();
    expect(screen.getByText('Eastern Time (ET)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Need help?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '(843) 555-0100' })).toHaveAttribute(
      'href',
      'tel:+18435550100',
    );
    expect(screen.getByRole('link', { name: 'help@example.test' })).toHaveAttribute(
      'href',
      'mailto:help@example.test',
    );
    expect(document.body.textContent).not.toContain(credential);
    expect(window.location.hash).toBe('');
  });

  it('loads a seven-day window, rotates the credential, and keeps the session active', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: managedAppointment() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            timezone: 'America/New_York',
            items: [
              {
                starts_at: '2026-09-05T15:00:00.000Z',
                ends_at: '2026-09-05T15:30:00.000Z',
                local_start: '2026-09-05T11:00:00-04:00',
                timezone: 'America/New_York',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: managedAppointment({
            starts_at: '2026-09-05T15:00:00.000Z',
            version: 2,
            replacement: { token_public_id: replacementId, credential: replacementCredential },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: managedAppointment({ status: 'cancelled', version: 3, replacement: null }),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    render(<PublicAppointmentManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    expect(screen.getByRole('heading', { name: 'Choose a new time' })).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Start of seven-day window'), {
      target: { value: '2026-09-05' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /September 5/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new time' }));
    expect(
      await screen.findByText('Your appointment has been successfully rescheduled.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We've emailed you an updated appointment confirmation with a new management link.",
      ),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/appointments/manage/${replacementId}`);
    expect(window.location.hash).toBe('');
    expect(storageSet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'CANCEL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this appointment' }));
    expect(await screen.findByText('Your appointment was cancelled.')).toBeInTheDocument();
    expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
    const cancellationHeaders = fetchMock.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
    expect(cancellationHeaders.Authorization).toBe(`AppointmentToken ${replacementCredential}`);
  });

  it.each([
    [404, 'appointment_link_unavailable', 'most recent appointment email'],
    [429, 'rate_limited', 'Too many requests'],
  ])('shows a safe initial error and retry control for %s', async (status, code, text) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: { code } })));
    render(<PublicAppointmentManagementPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('gives clear next steps when a management link is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: { code: 'appointment_link_unavailable' } })),
    );
    render(<PublicAppointmentManagementPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This appointment link is no longer available');
    expect(alert).toHaveTextContent('expired or already been replaced');
    expect(alert).toHaveTextContent('contact the business for assistance');
  });

  it('omits the help section when no public contact details are configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: managedAppointment({ business: { phone: null, email: null } }),
        }),
      ),
    );
    render(<PublicAppointmentManagementPage />);
    await screen.findByRole('heading', { name: 'Harbor Service' });
    expect(screen.queryByRole('heading', { name: 'Need help?' })).not.toBeInTheDocument();
  });

  it.each([
    [409, 'start_unavailable', 'no longer available'],
    [409, 'version_conflict', 'changed in another session'],
    [409, 'action_unavailable', 'cutoff has passed'],
    [429, 'rate_limited', 'Too many requests'],
  ])('announces safe reschedule mutation errors for %s/%s', async (status, code, text) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: managedAppointment() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            timezone: 'America/New_York',
            items: [
              {
                starts_at: '2026-09-05T15:00:00.000Z',
                ends_at: '2026-09-05T15:30:00.000Z',
                local_start: '2026-09-05T11:00:00-04:00',
                timezone: 'America/New_York',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(status, { error: { code } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAppointmentManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    fireEvent.change(screen.getByLabelText('Start of seven-day window'), {
      target: { value: '2026-09-05' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /September 5/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new time' }));
    expect(await screen.findByText(new RegExp(text, 'i'))).toBeInTheDocument();
  });

  it('supports keyboard cancellation confirmation and a 320px viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { data: managedAppointment() })),
    );
    render(<PublicAppointmentManagementPage />);
    const cancel = await screen.findByRole('button', { name: 'Cancel appointment' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Enter' });
    fireEvent.click(cancel);
    expect(screen.getByRole('heading', { name: 'Cancel appointment' })).toHaveFocus();
    const confirmation = screen.getByLabelText('Confirmation');
    const destructiveAction = screen.getByRole('button', { name: 'Cancel this appointment' });
    expect(destructiveAction).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: 'cancel' } });
    expect(confirmation).toHaveValue('CANCEL');
    expect(destructiveAction).toBeEnabled();
    expect(document.querySelector('.management-page')).toBeInTheDocument();
  });
});

describe('formatTimezone', () => {
  it('presents IANA timezones with customer-friendly generic names', () => {
    expect(formatTimezone('America/New_York')).toBe('Eastern Time (ET)');
    expect(formatTimezone('America/Chicago')).toBe('Central Time (CT)');
  });
});

function managedAppointment(overrides: Record<string, unknown> = {}) {
  const replacement = overrides.replacement;
  const business = (overrides.business as Record<string, unknown> | undefined) ?? {};
  return {
    business: {
      name: 'Safe Business',
      logo_url: null,
      primary_color: '#176CAB',
      phone: '+18435550100',
      email: 'help@example.test',
      website: 'https://example.test',
      ...business,
    },
    appointment: {
      reference: 'BNT-12345678',
      status: overrides.status ?? 'scheduled',
      service_name: 'Harbor Service',
      duration_minutes: 30,
      provider_name: 'Lisa',
      provider_photo_url: null,
      starts_at: overrides.starts_at ?? '2026-09-03T14:00:00.000Z',
      ends_at: '2026-09-03T14:30:00.000Z',
      local_start: '2026-09-03T10:00:00-04:00',
      timezone: 'America/New_York',
      version: overrides.version ?? 1,
    },
    actions: {
      can_reschedule: overrides.status !== 'cancelled',
      can_cancel: overrides.status !== 'cancelled',
      reschedule_until: '2026-09-02T14:00:00.000Z',
      cancel_until: '2026-09-02T14:00:00.000Z',
    },
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}
