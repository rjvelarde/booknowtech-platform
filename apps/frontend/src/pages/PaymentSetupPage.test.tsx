import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaymentSetupPage } from './PaymentSetupPage.js';

describe('PaymentSetupPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('separates BookNowTech acceptance from Stripe readiness and explains the non-payment boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              foundation_enabled: true,
              booknowtech_terms: { version: 'connect-v1', accepted: true },
              account: {
                public_id: 'account-public',
                status: 'pending_verification',
                details_submitted: true,
                charges_enabled: false,
                payouts_enabled: false,
                capabilities: { card_payments: 'pending', transfers: 'pending' },
                requirements: {
                  currently_due: [],
                  past_due: [],
                  pending_verification: ['individual.verification.document'],
                },
                last_synced_at: null,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    render(<PaymentSetupPage csrfToken="csrf" canManage />);
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText(/does not enable paid booking or move money/i)).toBeInTheDocument();
    expect(screen.getByText(/Account status:/)).toHaveTextContent('pending verification');
    expect(screen.queryByText(/BookNowTech terms.*pending verification/i)).not.toBeInTheDocument();
  });

  it('keeps status visible but disables onboarding during primary rollback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              foundation_enabled: false,
              booknowtech_terms: { version: 'connect-v1', accepted: false },
              account: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    render(<PaymentSetupPage csrfToken="csrf" canManage />);
    expect(await screen.findByRole('status')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Accept BookNowTech Connect Terms' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start Stripe onboarding' })).toBeDisabled();
  });
});
