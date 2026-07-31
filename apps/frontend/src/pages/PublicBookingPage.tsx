import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import {
  ApiError,
  type PublicBookingContextView,
  type PublicProviderView,
  type PublicServiceView,
  type PublicStartView,
  getPublicBookingContext,
  listPublicProviders,
  listPublicServices,
  listPublicStarts,
} from '../api/client.js';

export function PublicBookingPage() {
  const [context, setContext] = useState<PublicBookingContextView | null>(null);
  const [services, setServices] = useState<PublicServiceView[]>([]);
  const [service, setService] = useState<PublicServiceView | null>(null);
  const [providers, setProviders] = useState<PublicProviderView[]>([]);
  const [provider, setProvider] = useState<PublicProviderView | null>(null);
  const [date, setDate] = useState('');
  const [starts, setStarts] = useState<PublicStartView[]>([]);
  const [selectedStart, setSelectedStart] = useState<PublicStartView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    Promise.all([getPublicBookingContext(), listPublicServices()])
      .then(([nextContext, nextServices]) => {
        setContext(nextContext);
        setServices(nextServices.items);
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof ApiError && reason.status === 404
            ? 'This booking page is not available.'
            : 'Unable to load this booking page. Please try again.',
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  const chooseService = async (next: PublicServiceView) => {
    setService(next);
    setProvider(null);
    setDate('');
    setStarts([]);
    setSelectedStart(null);
    setLoading(true);
    setError(null);
    try {
      setProviders((await listPublicProviders(next.public_id)).items);
    } catch {
      setError('Unable to load providers. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadStarts = async (nextDate: string) => {
    setDate(nextDate);
    setStarts([]);
    setSelectedStart(null);
    if (!service || !provider || !nextDate) return;
    setLoading(true);
    setError(null);
    try {
      setStarts(
        (await listPublicStarts(service.public_id, provider.public_id, nextDate, nextDate)).items,
      );
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === 'date_outside_booking_window'
          ? 'That date is outside this business’s booking window.'
          : 'Unable to load available times. Please try another date.',
      );
    } finally {
      setLoading(false);
    }
  };

  if (loading && !context) return <PublicStatus message="Loading booking page…" />;
  if (error && !context) return <PublicStatus message={error} alert />;
  if (!context) return null;

  return (
    <main
      className="public-booking-page"
      style={{ '--booking-accent': context.business.primary_color ?? '#1261A0' } as CSSProperties}
    >
      <header className="public-booking-header">
        {context.business.logo_url && !logoFailed ? (
          <img
            src={context.business.logo_url}
            alt={`${context.business.name} logo`}
            className="public-booking-logo"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <div className="public-booking-initials" aria-hidden="true">
            {context.business.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="public-booking-identity">
          <p className="eyebrow">Book an appointment</p>
          <h1>{context.business.name}</h1>
          {context.business.tagline ? (
            <p className="public-booking-tagline">{context.business.tagline}</p>
          ) : null}
        </div>
      </header>
      <section className="public-booking-flow" aria-live="polite">
        {context.business.description ? (
          <p className="public-booking-description">{context.business.description}</p>
        ) : null}
        <Step number={1} title="Service">
          <div className="public-choice-grid">
            {services.map((item) => (
              <button
                type="button"
                key={item.public_id}
                className={
                  service?.public_id === item.public_id ? 'public-choice selected' : 'public-choice'
                }
                aria-pressed={service?.public_id === item.public_id}
                onClick={() => void chooseService(item)}
              >
                <strong className="public-choice-title">{item.name}</strong>
                <span className="public-choice-detail">
                  {item.duration_minutes} minutes · {money(item.base_price_minor, item.currency)}
                </span>
                {service?.public_id === item.public_id ? <SelectedBadge /> : null}
              </button>
            ))}
          </div>
          {services.length === 0 ? <p>No services are available for online discovery.</p> : null}
        </Step>

        {service ? (
          <Step number={2} title="Provider">
            <div className="public-choice-grid">
              {providers.map((item) => (
                <button
                  type="button"
                  key={item.public_id}
                  className={
                    provider?.public_id === item.public_id
                      ? 'public-choice selected'
                      : 'public-choice'
                  }
                  aria-pressed={provider?.public_id === item.public_id}
                  onClick={() => {
                    setProvider(item);
                    setDate('');
                    setStarts([]);
                    setSelectedStart(null);
                  }}
                >
                  <ProviderAvatar provider={item} />
                  <span className="public-provider-copy">
                    <strong className="public-choice-title">{item.display_name}</strong>
                    {item.bio ? <span className="public-choice-detail">{item.bio}</span> : null}
                  </span>
                  {provider?.public_id === item.public_id ? <SelectedBadge /> : null}
                </button>
              ))}
            </div>
            {providers.length === 0 && !loading ? (
              <p>No providers are currently available for this service.</p>
            ) : null}
          </Step>
        ) : null}

        {provider ? (
          <Step number={3} title="Date">
            <div className="public-date-panel">
              <label className="public-date-field">
                <span>Appointment date</span>
                <input
                  type="date"
                  value={date}
                  onChange={(event) => void loadStarts(event.target.value)}
                />
              </label>
              <p>Choose a date to see this provider’s available appointment times.</p>
            </div>
          </Step>
        ) : null}

        {date ? (
          <Step number={4} title="Time">
            {loading ? <p role="status">Loading available times…</p> : null}
            <div className="public-time-grid">
              {starts.map((item) => (
                <button
                  type="button"
                  key={item.starts_at}
                  className={
                    selectedStart?.starts_at === item.starts_at
                      ? 'public-time selected'
                      : 'public-time'
                  }
                  aria-pressed={selectedStart?.starts_at === item.starts_at}
                  onClick={() => setSelectedStart(item)}
                >
                  <span>{timeLabel(item.local_start)}</span>
                  {selectedStart?.starts_at === item.starts_at ? <SelectedBadge /> : null}
                </button>
              ))}
            </div>
            {!loading && starts.length === 0 ? (
              <div className="public-empty-state" role="status">
                <strong>No appointments are available for this date.</strong>
                <span>Try another date or provider.</span>
              </div>
            ) : null}
          </Step>
        ) : null}

        {selectedStart && service && provider ? (
          <section className="public-booking-summary" aria-labelledby="booking-summary-title">
            <h2 id="booking-summary-title">Your selection</h2>
            <p>
              <strong>{service.name}</strong> with {provider.display_name}
            </p>
            <p>
              {new Date(selectedStart.starts_at).toLocaleString([], {
                dateStyle: 'long',
                timeStyle: 'short',
                timeZone: selectedStart.timezone,
              })}
            </p>
            <p className="public-coming-soon" role="status">
              Online booking is coming soon. This selection has not been reserved or submitted.
            </p>
          </section>
        ) : null}
        {error && context ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="public-booking-step" aria-labelledby={`public-booking-step-${number}`}>
      <h2 id={`public-booking-step-${number}`}>
        <span className="public-step-number" aria-hidden="true">
          {number}
        </span>
        <span>
          <small>Step {number} of 4</small>
          {title}
        </span>
      </h2>
      {children}
    </section>
  );
}

function SelectedBadge() {
  return <span className="public-selected-badge">✓ Selected</span>;
}

function ProviderAvatar({ provider }: { provider: PublicProviderView }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const initials = provider.display_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return provider.photo_url && !photoFailed ? (
    <img
      className="public-provider-avatar"
      src={provider.photo_url}
      alt=""
      onError={() => setPhotoFailed(true)}
    />
  ) : (
    <span className="public-provider-avatar public-provider-initials" aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

function PublicStatus({ message, alert = false }: { message: string; alert?: boolean }) {
  return (
    <main className="landing-page">
      <section className="landing-card">
        <h1>Booking</h1>
        <p className="status-copy" role={alert ? 'alert' : 'status'}>
          {message}
        </p>
      </section>
    </main>
  );
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
}

function timeLabel(local: string) {
  const value = local.slice(11, 16);
  const [hourText, minute] = value.split(':');
  const hour = Number(hourText);
  if (!Number.isInteger(hour) || minute === undefined) return value;
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}
