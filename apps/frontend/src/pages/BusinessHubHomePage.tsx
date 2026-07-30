import type { AdminSessionView } from '../api/client.js';
import type { ReactNode } from 'react';

interface BusinessHubHomePageProps {
  session: AdminSessionView;
  busy: boolean;
  error: string | null;
  onSwitch: () => void;
  onLogout: () => Promise<void>;
  onNavigate: (path: string) => void;
  children?: ReactNode;
}

export function BusinessHubHomePage({
  session,
  busy,
  error,
  onSwitch,
  onLogout,
  onNavigate,
  children,
}: BusinessHubHomePageProps) {
  const tenant = session.active_tenant!;
  return (
    <main className="hub-page">
      <header className="hub-header">
        <div>
          <p className="eyebrow">BookNowTech</p>
          <strong>Business Hub</strong>
        </div>
        <button type="button" disabled={busy} onClick={() => void onLogout()}>
          Sign out
        </button>
      </header>
      <section className="hub-content" aria-labelledby="hub-title">
        <p className="eyebrow">Active business</p>
        <h1 id="hub-title">{tenant.display_name}</h1>
        <p className="status-copy">
          Signed in as {session.user.display_name} · {tenant.role.replaceAll('_', ' ')}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            Unable to sign out. Please try again.
          </p>
        ) : null}
        {session.memberships.length > 1 ? (
          <button type="button" className="secondary-button" onClick={onSwitch}>
            Switch business
          </button>
        ) : null}
        <nav className="hub-nav" aria-label="Business Hub">
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate('/business')}
          >
            Business profile
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate('/services')}
          >
            Services
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate('/public-booking')}
          >
            Public booking
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate('/providers')}
          >
            Providers
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate('/availability/closures')}
          >
            Closures
          </button>
          {tenant.role !== 'provider' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigate('/appointments')}
            >
              Appointments
            </button>
          ) : null}
          {tenant.role !== 'provider' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigate('/customers')}
            >
              Customers
            </button>
          ) : null}
        </nav>
        <div className="workspace">
          {children ?? (
            <div className="empty-state">
              <h2>Your Business Hub is ready</h2>
              <p>Manage your business profile and service catalog.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
