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
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [10000, 2500, 125, 2625, 7500],
    [10000, 10000, 125, 10125, 0],
    [50000, 10000, 100, 10100, 40000],
  ])(
    'formats the accepted backend snapshot example %# without recalculating it',
    (service, providerDue, fee, total, remaining) => {
      renderCheckout(
        attempt({
          amounts: {
            service_price_minor: service,
            provider_amount_due_now_minor: providerDue,
            booknowtech_fee_minor: fee,
            customer_total_due_now_minor: total,
            application_fee_amount_minor: fee,
            remaining_service_balance_minor: remaining,
            currency: 'USD',
          },
        }),
      );
      for (const value of [service, providerDue, fee, total, remaining])
        expect(screen.getAllByText(money(value)).length).toBeGreaterThan(0);
    },
  );

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
    const recover = vi
      .fn()
      .mockResolvedValueOnce(attempt({ payment_status: 'processing', client_secret: null }));
    const onUpdate = vi.fn();
    renderCheckout(attempt(), onUpdate, recover);
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
    expect(recover).toHaveBeenCalledOnce();
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

  it('uses a bounded decline message and moves focus to the accessible error', async () => {
    confirmPayment.mockResolvedValueOnce({ error: { message: 'raw processor detail' } });
    renderCheckout(attempt());
    fireEvent.click(screen.getByRole('button', { name: 'Pay $21.25' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your card could not be confirmed');
    expect(alert).not.toHaveTextContent('raw processor detail');
    expect(alert).toHaveFocus();
  });
});

function renderCheckout(
  value: PublicPaymentAttemptView,
  onUpdate = vi.fn(),
  recover = vi.fn(() => Promise.resolve(value)),
) {
  return render(
    <PublicPaymentCheckout
      attempt={value}
      publishableKey="pk_test_synthetic"
      recover={recover}
      onUpdate={onUpdate}
      onRestart={vi.fn()}
    />,
  );
}

function money(minor: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
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
    continuation_allowed: true,
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
