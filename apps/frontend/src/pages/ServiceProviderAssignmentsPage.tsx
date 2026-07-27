import { useEffect, useState } from 'react';

import {
  type AssignmentView,
  type ServiceView,
  getService,
  listServiceProviderAssignments,
} from '../api/client.js';

export function ServiceProviderAssignmentsPage({
  publicId,
  onNavigate,
}: {
  publicId: string;
  onNavigate: (path: string) => void;
}) {
  const [service, setService] = useState<ServiceView | null>(null);
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    void Promise.all([getService(publicId), listServiceProviderAssignments(publicId)])
      .then(([nextService, nextAssignments]) => {
        setService(nextService);
        setAssignments(nextAssignments);
      })
      .catch(() => setError(true));
  }, [publicId]);
  if (error) return <p role="alert">Unable to load service provider assignments.</p>;
  if (!service) return <p>Loading service…</p>;
  return (
    <section aria-labelledby="service-detail-title">
      <button type="button" className="secondary-button" onClick={() => onNavigate('/services')}>
        Back to services
      </button>
      <p className="eyebrow">Service</p>
      <h1 id="service-detail-title">{service.name}</h1>
      <p>
        {service.status} · {service.duration_minutes} minutes
      </p>
      <h2>Assigned providers</h2>
      <div className="service-list">
        {assignments.map((assignment) => (
          <article className="service-card" key={assignment.public_id}>
            <div>
              <h3>{assignment.provider.display_name}</h3>
              <p>
                {assignment.operationally_eligible
                  ? 'Operationally eligible'
                  : 'Not operationally eligible'}
              </p>
              <p>
                Provider: {assignment.provider.status} · Assignment: {assignment.status} · Customer
                selectable: {assignment.provider.customer_selectable ? 'yes' : 'no'} · Accepting new
                clients: {assignment.provider.accepting_new_clients ? 'yes' : 'no'}
              </p>
              <span className={`status-pill ${assignment.status}`}>{assignment.status}</span>
            </div>
          </article>
        ))}
        {assignments.length === 0 ? <p>No providers are assigned.</p> : null}
      </div>
    </section>
  );
}
