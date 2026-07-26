import type { AdminSessionView } from '../api/client.js';

interface TenantSelectionPageProps {
  session: AdminSessionView;
  busy: boolean;
  onSelect: (publicId: string) => Promise<void>;
}

export function TenantSelectionPage({ session, busy, onSelect }: TenantSelectionPageProps) {
  return (
    <main className="landing-page">
      <section className="landing-card" aria-labelledby="tenant-title">
        <p className="eyebrow">BookNowTech Business Hub</p>
        <h1 id="tenant-title">Choose a business</h1>
        <p className="status-copy">Select an authorized membership to continue.</p>
        <div className="tenant-list">
          {session.memberships.map((membership) => (
            <button
              key={membership.public_id}
              type="button"
              disabled={busy}
              onClick={() => void onSelect(membership.public_id)}
            >
              <span>{membership.tenant.display_name}</span>
              <small>{membership.role.replaceAll('_', ' ')}</small>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
