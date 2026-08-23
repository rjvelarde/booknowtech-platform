import { useEffect, useState } from 'react';

import {
  type ConnectStatusView,
  acceptBookNowTechConnectTerms,
  createConnectAccountLink,
  getConnectStatus,
  startConnectOnboarding,
} from '../api/client.js';

export function PaymentSetupPage({
  csrfToken,
  canManage,
}: {
  csrfToken: string;
  canManage: boolean;
}) {
  const [status, setStatus] = useState<ConnectStatusView | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    getConnectStatus()
      .then(setStatus)
      .catch(() => setError(true));
  useEffect(() => {
    void refresh();
  }, []);
  if (error) return <p role="alert">Unable to load Stripe Connect setup.</p>;
  if (!status) return <p>Loading Stripe Connect setup…</p>;
  return (
    <section aria-labelledby="payment-setup-title">
      <p className="eyebrow">Stripe Connect foundation</p>
      <h1 id="payment-setup-title">Payment account setup</h1>
      <p className="form-note">
        This setup connects your business with Stripe. It does not enable paid booking or move
        money.
      </p>
      {!status.foundation_enabled ? (
        <p role="status">
          Stripe Connect onboarding is temporarily unavailable. Existing account updates continue to
          process.
        </p>
      ) : null}
      <h2>BookNowTech Connect Terms</h2>
      <p>Version: {status.booknowtech_terms.version}</p>
      <p>
        {status.booknowtech_terms.accepted
          ? 'Accepted'
          : 'Acceptance required before Stripe onboarding.'}
      </p>
      {!status.booknowtech_terms.accepted ? (
        <button
          type="button"
          disabled={!canManage || busy || !status.foundation_enabled}
          onClick={() => {
            setBusy(true);
            void acceptBookNowTechConnectTerms(csrfToken)
              .then(refresh)
              .catch(() => setError(true))
              .finally(() => setBusy(false));
          }}
        >
          Accept BookNowTech Connect Terms
        </button>
      ) : null}
      <h2>Stripe-hosted onboarding</h2>
      {status.account ? (
        <>
          <p>
            Account status: <strong>{status.account.status.replaceAll('_', ' ')}</strong>
          </p>
          <p>
            Payments capability: {status.account.charges_enabled ? 'enabled' : 'not enabled'} ·
            Payouts: {status.account.payouts_enabled ? 'enabled' : 'not enabled'}
          </p>
          {[...status.account.requirements.currently_due, ...status.account.requirements.past_due]
            .length ? (
            <p>Stripe requires additional information. Continue onboarding for details.</p>
          ) : null}
          <button
            type="button"
            disabled={!canManage || busy || !status.foundation_enabled}
            onClick={() => {
              setBusy(true);
              void createConnectAccountLink(csrfToken)
                .then(({ url }) => {
                  window.location.assign(url);
                })
                .catch(() => setError(true))
                .finally(() => setBusy(false));
            }}
          >
            Continue with Stripe
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={
            !canManage || busy || !status.foundation_enabled || !status.booknowtech_terms.accepted
          }
          onClick={() => {
            setBusy(true);
            void startConnectOnboarding(csrfToken)
              .then(() => createConnectAccountLink(csrfToken))
              .then(({ url }) => {
                window.location.assign(url);
              })
              .catch(() => setError(true))
              .finally(() => setBusy(false));
          }}
        >
          Start Stripe onboarding
        </button>
      )}
    </section>
  );
}
