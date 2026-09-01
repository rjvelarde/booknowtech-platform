import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type PublicPaymentAttemptView } from '../api/client.js';

export function PublicPaymentCheckout({
  attempt,
  publishableKey,
  recover,
  onUpdate,
  onRestart,
}: {
  attempt: PublicPaymentAttemptView;
  publishableKey: string;
  recover: () => Promise<PublicPaymentAttemptView>;
  onUpdate: (attempt: PublicPaymentAttemptView) => void;
  onRestart: (message: string) => void;
}) {
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const stripePromise = useMemo(
    () =>
      attempt.stripe_account
        ? loadStripe(publishableKey, { stripeAccount: attempt.stripe_account })
        : null,
    [attempt.stripe_account, publishableKey],
  );

  if (attempt.appointment_status === 'scheduled' && attempt.payment_status === 'succeeded')
    return <PaidResult attempt={attempt} />;
  if (['expired', 'terminal_failure'].includes(attempt.payment_status))
    return (
      <CheckoutStatus
        title={attempt.payment_status === 'expired' ? 'Payment time expired' : 'Payment stopped'}
        message="This provisional appointment was not confirmed and the time is no longer held. Start again to use current availability and pricing."
        action="Start again"
        onAction={() => onRestart('Please choose an available time and start a new checkout.')}
      />
    );
  if (attempt.payment_status === 'manual_review')
    return (
      <CheckoutStatus
        title="Payment needs review"
        message="Do not submit another payment. Your appointment is not yet confirmed. The payment status is being reviewed."
      />
    );
  if (attempt.payment_status === 'processing' || attempt.payment_status === 'temporary_recovery')
    return (
      <CheckoutStatus
        title="Payment is pending"
        message="Your time is provisionally held, but the appointment is not confirmed yet. Check again for the authoritative booking status."
        action="Check status"
        error={refreshError}
        onAction={() => {
          setRefreshError(null);
          void refreshAttempt(recover, onUpdate, onRestart).catch(() =>
            setRefreshError(
              'Payment status could not be checked. Do not submit another payment; try again shortly.',
            ),
          );
        }}
      />
    );
  if (!attempt.continuation_allowed)
    return (
      <CheckoutStatus
        title="Payment can no longer continue"
        message="This checkout is not payment-actionable. Start again to use current availability and pricing."
        action="Start again"
        onAction={() => onRestart('Please choose an available time and start a new checkout.')}
      />
    );
  if (!attempt.client_secret || !stripePromise)
    return (
      <CheckoutStatus
        title="Checkout temporarily unavailable"
        message="Your appointment is not confirmed. Try checking the payment status again."
        action="Try again"
        error={refreshError}
        onAction={() => {
          setRefreshError(null);
          void refreshAttempt(recover, onUpdate, onRestart).catch(() =>
            setRefreshError(
              'Payment status could not be checked. Do not submit another payment; try again shortly.',
            ),
          );
        }}
      />
    );

  return (
    <section className="public-payment-checkout" aria-labelledby="payment-title">
      <h2 id="payment-title">Secure card checkout</h2>
      <AmountBreakdown attempt={attempt} />
      <p className="public-payment-hold" role="status">
        This time is provisionally held until {new Date(attempt.expires_at).toLocaleTimeString()}.
        Your appointment is not confirmed until payment is successfully completed.
      </p>
      <Elements
        stripe={stripePromise}
        options={{ clientSecret: attempt.client_secret, appearance: { theme: 'stripe' } }}
      >
        <PaymentForm
          attempt={attempt}
          recover={recover}
          onUpdate={onUpdate}
          onRestart={onRestart}
        />
      </Elements>
    </section>
  );
}

function PaymentForm({
  attempt,
  recover,
  onUpdate,
  onRestart,
}: {
  attempt: PublicPaymentAttemptView;
  recover: () => Promise<PublicPaymentAttemptView>;
  onUpdate: (attempt: PublicPaymentAttemptView) => void;
  onRestart: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    attempt.payment_status === 'recoverable_failure'
      ? 'Your card was not accepted. You can retry this same payment while the hold is active.'
      : null,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!stripe || !elements || submitting) return;
        setSubmitting(true);
        setError(null);
        void stripe
          .confirmPayment({ elements, redirect: 'if_required' })
          .then(async ({ error: stripeError }) => {
            if (stripeError) {
              setError('Your card could not be confirmed. Review the card details and try again.');
              return;
            }
            await refreshAttempt(recover, onUpdate, onRestart);
          })
          .catch(() =>
            setError('Payment status could not be checked. Your appointment is not confirmed.'),
          )
          .finally(() => setSubmitting(false));
      }}
    >
      <PaymentElement options={{ paymentMethodOrder: ['card'] }} />
      {error ? (
        <p ref={errorRef} className="form-error" role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={!stripe || !elements || submitting} aria-busy={submitting}>
        {submitting
          ? 'Submitting payment…'
          : `Pay ${money(attempt.amounts.customer_total_due_now_minor)}`}
      </button>
    </form>
  );
}

function AmountBreakdown({ attempt }: { attempt: PublicPaymentAttemptView }) {
  const amount = attempt.amounts;
  const deposit = amount.remaining_service_balance_minor > 0;
  return (
    <div className="public-payment-breakdown">
      <h3>Amount due now</h3>
      <dl>
        <div>
          <dt>Service price</dt>
          <dd>{money(amount.service_price_minor)}</dd>
        </div>
        <div>
          <dt>{deposit ? 'Deposit paid to provider now' : 'Provider amount due now'}</dt>
          <dd>{money(amount.provider_amount_due_now_minor)}</dd>
        </div>
        <div>
          <dt>Online booking fee</dt>
          <dd>{money(amount.booknowtech_fee_minor)}</dd>
        </div>
        <div className="public-payment-total">
          <dt>Total charged now</dt>
          <dd>{money(amount.customer_total_due_now_minor)}</dd>
        </div>
        <div>
          <dt>Remaining service balance (informational)</dt>
          <dd>{money(amount.remaining_service_balance_minor)}</dd>
        </div>
      </dl>
      {deposit ? (
        <p>
          The remaining service balance is paid directly to the provider and is not included in
          today's charge.
        </p>
      ) : null}
      <p>
        All amounts are USD. The booking fee is normally non-refundable for customer cancellation.
      </p>
      <p className="public-payment-disclosure">
        Online booking services and the applicable booking fee are provided by Mobile Up Tech Inc.
      </p>
    </div>
  );
}

function PaidResult({ attempt }: { attempt: PublicPaymentAttemptView }) {
  return (
    <CheckoutStatus
      title="Appointment confirmed"
      message={`Your payment was finalized and appointment ${attempt.appointment_reference} is scheduled. Stripe will email your payment receipt.`}
    />
  );
}

function CheckoutStatus({
  title,
  message,
  action,
  onAction,
  error,
}: {
  title: string;
  message: string;
  action?: string;
  onAction?: () => void;
  error?: string | null;
}) {
  return (
    <section
      className="public-booking-summary public-confirmation"
      aria-labelledby="payment-status-title"
    >
      <h2 id="payment-status-title">{title}</h2>
      <p>{message}</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {action && onAction ? (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

async function refreshAttempt(
  recover: () => Promise<PublicPaymentAttemptView>,
  onUpdate: (attempt: PublicPaymentAttemptView) => void,
  onRestart: (message: string) => void,
) {
  try {
    onUpdate(await recover());
  } catch (reason) {
    if (
      reason instanceof ApiError &&
      ['payment_attempt_stale', 'payment_configuration_changed'].includes(reason.code)
    ) {
      onRestart('Booking details changed. Review current availability and start a new checkout.');
      return;
    }
    throw reason;
  }
}

function money(minor: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
}
