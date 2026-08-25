import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicPaymentAttemptView } from '../api/client.js';
import { PublicPaymentCheckout } from './PublicPaymentCheckout.js';

const confirmPayment = vi.fn();

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => children,
  PaymentElement: () => <div aria-label="Card details" />,
  useElements: () => ({}),
  useStripe: () => ({ confirmPayment }),
}));

describe('PublicPaymentCheckout', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the backend amount snapshot and never claims a pending attempt is booked', () => {
    renderCheckout(attempt());
    expect(screen.getByText('$55.00')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.getByText('$1.25')).toBeInTheDocument();
    expect(screen.getByText('$21.25')).toBeInTheDocument();
    expect(screen.getByText('$35.00')).toBeInTheDocument();
    expect(screen.getByText(/provisionally held/i)).toBeInTheDocument();
    expect(screen.queryByText(/you.re booked/i)).not.toBeInTheDocument();
  });

  it('confirms through Stripe then reads the durable attempt before showing confirmation', async () => {
    confirmPayment.mockResolvedValueOnce({});
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ data: attempt({ payment_status: 'processing', client_secret: null }) }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn();
    renderCheckout(attempt(), onUpdate);
    fireEvent.click(screen.getByRole('button', { name: 'Pay $21.25' }));
    await waitFor(() =>
      expect(confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ redirect: 'if_required' }),
      ),
    );
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ payment_status: 'processing' }),
      ),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/payment-attempts/attempt-id/continue');
  });

  it('shows confirmation only for backend scheduled and succeeded state', () => {
    renderCheckout(
      attempt({
        appointment_status: 'scheduled',
        payment_status: 'succeeded',
        client_secret: null,
      }),
    );
    expect(screen.getByRole('heading', { name: 'Appointment confirmed' })).toBeInTheDocument();
  });
});

function renderCheckout(value: PublicPaymentAttemptView, onUpdate = vi.fn()) {
  return render(
    <PublicPaymentCheckout
      attempt={value}
      requestBody={{ service_public_id: 'service' }}
      idempotencyKey="11111111-1111-4111-8111-111111111111"
      publishableKey="pk_test_synthetic"
      onUpdate={onUpdate}
      onRestart={vi.fn()}
    />,
  );
}

function attempt(overrides: Partial<PublicPaymentAttemptView> = {}): PublicPaymentAttemptView {
  return {
    appointment_reference: 'BNT-PAID01',
    appointment_status: 'payment_pending',
    payment_attempt_public_id: 'attempt-id',
    payment_status: 'payment_method_required',
    expires_at: '2026-08-25T19:00:00.000Z',
    client_secret: 'pi_synthetic_secret_synthetic',
    stripe_account: 'acct_synthetic',
    amounts: {
      service_price_minor: 5500,
      provider_amount_due_now_minor: 2000,
      booknowtech_fee_minor: 125,
      customer_total_due_now_minor: 2125,
      application_fee_amount_minor: 125,
      remaining_service_balance_minor: 3500,
      currency: 'USD',
    },
    ...overrides,
  };
}
