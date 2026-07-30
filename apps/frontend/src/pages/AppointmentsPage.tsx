import { useEffect, useState } from 'react';

import {
  ApiError,
  type AppointmentView,
  type CustomerView,
  type ProviderView,
  createAppointment,
  getAppointment,
  getProvider,
  listAppointments,
  listCustomers,
  listProviders,
  previewSchedulingSlots,
  rescheduleAppointment,
  transitionAppointment,
} from '../api/client.js';

interface Props {
  path: string;
  csrfToken: string;
  role: string;
  onNavigate: (path: string) => void;
}

export function AppointmentsPage(props: Props) {
  if (props.path === '/appointments/new') return <CreateAppointment {...props} />;
  const match = props.path.match(/^\/appointments\/([^/]+)$/);
  if (match) return <AppointmentDetail {...props} publicId={match[1]!} />;
  return <Agenda {...props} />;
}

function Agenda({ onNavigate }: Props) {
  const [items, setItems] = useState<AppointmentView[]>([]);
  const [view, setView] = useState<'today' | 'upcoming' | 'past'>('upcoming');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(false);
  const load = () => {
    const byReference = query.trim().toUpperCase().startsWith('BNT-');
    void listAppointments({
      view,
      ...(query.trim().length >= 2
        ? byReference
          ? { reference: query.trim() }
          : { customer_query: query.trim() }
        : {}),
    })
      .then((result) => {
        setItems(result.items);
        setError(false);
      })
      .catch(() => setError(true));
  };
  useEffect(load, [view]);
  return (
    <section aria-labelledby="appointments-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Appointments</p>
          <h2 id="appointments-title">Agenda</h2>
        </div>
        <button type="button" onClick={() => onNavigate('/appointments/new')}>
          New appointment
        </button>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          load();
        }}
      >
        <label>
          View{' '}
          <select value={view} onChange={(event) => setView(event.target.value as typeof view)}>
            <option value="today">Today</option>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
          </select>
        </label>
        <label>
          Search{' '}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Customer or BNT reference"
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          Unable to load appointments.
        </p>
      ) : null}
      <div className="catalog-list">
        {items.map((item) => (
          <article className="catalog-card" key={item.public_id}>
            <div>
              <p className="eyebrow">{item.reference}</p>
              <h3>{item.customer.display_name}</h3>
              <p>
                {formatWhen(item.starts_at, item.timezone)} · {item.service.name} with{' '}
                {item.provider.display_name}
              </p>
              <span className={`status-pill ${item.status}`}>{item.status.replace('_', ' ')}</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigate(`/appointments/${item.public_id}`)}
            >
              View
            </button>
          </article>
        ))}
      </div>
      {!items.length && !error ? (
        <p className="empty-state">No appointments match this view.</p>
      ) : null}
    </section>
  );
}

function CreateAppointment({ csrfToken, onNavigate }: Props) {
  const [customers, setCustomers] = useState<CustomerView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [startsAt, setStartsAt] = useState('');
  const [slots, setSlots] = useState<Array<{ starts_at: string; local_start: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listCustomers({ status: 'active' }).then((r) => setCustomers(r.items));
    void listProviders('active').then((r) => setProviders(r.items));
  }, []);
  useEffect(() => {
    setServiceId('');
    setStartsAt('');
    setSlots([]);
    if (providerId) void getProvider(providerId).then(setProvider);
    else setProvider(null);
  }, [providerId]);
  const assignments =
    provider?.service_assignments?.filter(
      (item) => item.status === 'active' && item.service.status === 'active',
    ) ?? [];
  const preview = () => {
    if (!providerId || !serviceId) return;
    void previewSchedulingSlots(providerId, serviceId, date, date)
      .then((r) => {
        setSlots(r.data.slots);
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof ApiError ? reason.code : 'request_failed'),
      );
  };
  const submit = () => {
    if (!customerId || !providerId || !serviceId || !startsAt) return;
    void createAppointment(
      {
        customer_public_id: customerId,
        provider_public_id: providerId,
        service_public_id: serviceId,
        starts_at: startsAt,
      },
      csrfToken,
    )
      .then((item) => onNavigate(`/appointments/${item.public_id}`))
      .catch((reason: unknown) =>
        setError(reason instanceof ApiError ? reason.code : 'request_failed'),
      );
  };
  return (
    <section aria-labelledby="new-appointment-title">
      <button type="button" className="text-button" onClick={() => onNavigate('/appointments')}>
        ← Agenda
      </button>
      <h2 id="new-appointment-title">New appointment</h2>
      <div className="form-card stack-form">
        <label>
          Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select a customer</option>
            {customers.map((c) => (
              <option key={c.public_id} value={c.public_id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">Select a provider</option>
            {providers.map((p) => (
              <option key={p.public_id} value={p.public_id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service
          <select
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              setSlots([]);
              setStartsAt('');
            }}
            disabled={!provider}
          >
            <option value="">Select an assigned service</option>
            {assignments.map((a) => (
              <option key={a.service.public_id} value={a.service.public_id}>
                {a.service.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setSlots([]);
              setStartsAt('');
            }}
          />
        </label>
        <button type="button" className="secondary-button" disabled={!serviceId} onClick={preview}>
          Find available starts
        </button>
        {slots.length ? (
          <fieldset>
            <legend>Available starts</legend>
            <div className="slot-grid">
              {slots.map((slot) => (
                <button
                  type="button"
                  className={startsAt === slot.starts_at ? '' : 'secondary-button'}
                  key={slot.starts_at}
                  onClick={() => setStartsAt(slot.starts_at)}
                >
                  {new Date(slot.starts_at).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            Unable to continue: {error.replaceAll('_', ' ')}.
          </p>
        ) : null}
        <button type="button" disabled={!startsAt} onClick={submit}>
          Create appointment
        </button>
      </div>
    </section>
  );
}

function AppointmentDetail({
  publicId,
  csrfToken,
  role,
  onNavigate,
}: Props & { publicId: string }) {
  const [item, setItem] = useState<AppointmentView | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [newStart, setNewStart] = useState('');
  const [rescheduleSlots, setRescheduleSlots] = useState<Array<{ starts_at: string }>>([]);
  const [reason, setReason] = useState('customer_request');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getAppointment(publicId)
      .then(setItem)
      .catch(() => setError('appointment_not_found'));
  }, [publicId]);
  if (error && !item)
    return (
      <p className="form-error" role="alert">
        Unable to load appointment.
      </p>
    );
  if (!item) return <p>Loading appointment…</p>;
  const act = (action: 'cancel' | 'complete' | 'no-show') => {
    const early = new Date(item.starts_at).valueOf() > Date.now() && action !== 'cancel';
    const earlyOverride =
      early && (role === 'tenant_owner' || role === 'tenant_admin')
        ? window.confirm(
            'This appointment has not started. Confirm this correction will be recorded in the audit log.',
          )
        : false;
    if (early && !earlyOverride) return;
    const confirmed =
      action === 'cancel'
        ? window.confirm('Cancel this appointment? This cannot be undone.')
        : true;
    if (!confirmed) return;
    void transitionAppointment(
      item,
      action,
      action === 'cancel' ? { reason, detail: detail || null } : { early_override: earlyOverride },
      csrfToken,
    )
      .then(setItem)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : 'request_failed'));
  };
  const reschedule = () => {
    if (!newStart) return;
    void rescheduleAppointment(item, newStart, csrfToken)
      .then((next) => {
        setItem(next);
        setNewStart('');
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : 'request_failed'));
  };
  const findRescheduleSlots = () => {
    if (!rescheduleDate || !item.provider.public_id || !item.service.public_id) return;
    void previewSchedulingSlots(
      item.provider.public_id,
      item.service.public_id,
      rescheduleDate,
      rescheduleDate,
    )
      .then((result) => {
        setRescheduleSlots(result.data.slots);
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof ApiError ? reason.code : 'request_failed'),
      );
  };
  return (
    <section aria-labelledby="appointment-title">
      <button type="button" className="text-button" onClick={() => onNavigate('/appointments')}>
        ← Agenda
      </button>
      <p className="eyebrow">{item.reference}</p>
      <h2 id="appointment-title">{item.customer.display_name}</h2>
      <dl className="profile-grid">
        <div>
          <dt>Status</dt>
          <dd>{item.status.replace('_', ' ')}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{formatWhen(item.starts_at, item.timezone)}</dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>{item.service.name}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{item.provider.display_name}</dd>
        </div>
      </dl>
      {item.status === 'scheduled' ? (
        <>
          <div className="form-card stack-form">
            <h3>Reschedule</h3>
            <label>
              New date
              <input
                type="date"
                value={rescheduleDate}
                onChange={(e) => {
                  setRescheduleDate(e.target.value);
                  setRescheduleSlots([]);
                  setNewStart('');
                }}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!rescheduleDate}
              onClick={findRescheduleSlots}
            >
              Find available starts
            </button>
            {rescheduleSlots.length ? (
              <fieldset>
                <legend>Available starts</legend>
                <div className="slot-grid">
                  {rescheduleSlots.map((slot) => (
                    <button
                      type="button"
                      className={newStart === slot.starts_at ? '' : 'secondary-button'}
                      key={slot.starts_at}
                      onClick={() => setNewStart(slot.starts_at)}
                    >
                      {new Date(slot.starts_at).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone: item.timezone,
                      })}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <button type="button" disabled={!newStart} onClick={reschedule}>
              Reschedule appointment
            </button>
          </div>
          <div className="form-card stack-form">
            <h3>Cancel appointment</h3>
            <label>
              Reason
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="customer_request">Customer request</option>
                <option value="provider_unavailable">Provider unavailable</option>
                <option value="business_closed">Business closed</option>
                <option value="duplicate">Duplicate</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Internal detail (optional)
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)} />
            </label>
            <button type="button" className="secondary-button" onClick={() => act('cancel')}>
              Cancel appointment
            </button>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => act('complete')}>
              Mark complete
            </button>
            <button type="button" className="secondary-button" onClick={() => act('no-show')}>
              Mark no-show
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          Action failed: {error.replaceAll('_', ' ')}.
        </p>
      ) : null}
    </section>
  );
}

function formatWhen(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}
