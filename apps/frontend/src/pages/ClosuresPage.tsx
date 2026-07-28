import { useEffect, useState } from 'react';
import {
  type AvailabilityExceptionView,
  createAvailabilityException,
  getBusinessProfile,
  listAvailabilityExceptions,
  setAvailabilityExceptionActive,
} from '../api/client.js';
export function ClosuresPage({ csrfToken, canManage }: { csrfToken: string; canManage: boolean }) {
  const [items, setItems] = useState<AvailabilityExceptionView[]>([]),
    [name, setName] = useState(''),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [error, setError] = useState(false),
    [timezone, setTimezone] = useState('UTC');
  const load = () =>
    Promise.all([listAvailabilityExceptions(), getBusinessProfile()])
      .then(([x, profile]) => {
        setItems(x.filter((i) => i.scope === 'tenant'));
        setTimezone(profile.default_timezone);
      })
      .catch(() => setError(true));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section aria-labelledby="closures-title">
      <p className="eyebrow">Availability</p>
      <h1 id="closures-title">Holidays and closures</h1>
      {error ? <p role="alert">Unable to load closures.</p> : null}
      {canManage ? (
        <div className="form-grid">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Start
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            End (inclusive)
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <button
            onClick={() =>
              void createAvailabilityException(
                {
                  scope: 'tenant',
                  kind: 'closure',
                  name,
                  all_day: true,
                  timezone,
                  starts_on: start,
                  ends_before: addDay(end),
                },
                csrfToken,
              )
                .then(load)
                .catch(() => setError(true))
            }
          >
            Add closure
          </button>
        </div>
      ) : null}
      <div className="service-list">
        {items.map((item) => (
          <article className="service-card" key={item.public_id}>
            <div>
              <strong>{item.name ?? item.kind}</strong>
              <p>
                {item.starts_on ?? item.starts_at} to {item.ends_before ?? item.ends_at} ·{' '}
                {item.status}
              </p>
            </div>
            {canManage ? (
              <button
                className="secondary-button"
                onClick={() =>
                  void setAvailabilityExceptionActive(
                    item,
                    item.status !== 'active',
                    csrfToken,
                  ).then(load)
                }
              >
                {item.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
function addDay(value: string) {
  return value
    ? new Date(Date.parse(`${value}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
    : '';
}
