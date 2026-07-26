import type { AdminSessionView } from '../api/client.js';

interface BusinessHubHomePageProps {
  session: AdminSessionView;
  busy: boolean;
  onSwitch: () => void;
  onLogout: () => Promise<void>;
}

export function BusinessHubHomePage({
  session,
  busy,
  onSwitch,
  onLogout,
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
        {session.memberships.length > 1 ? (
          <button type="button" className="secondary-button" onClick={onSwitch}>
            Switch business
          </button>
        ) : null}
        <div className="empty-state">
          <h2>Your Business Hub is ready</h2>
          <p>
            Operational tools will be added through the approved roadmap, one reliable milestone at
            a time.
          </p>
        </div>
      </section>
    </main>
  );
}
