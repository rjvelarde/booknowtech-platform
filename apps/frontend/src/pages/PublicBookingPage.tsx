import { useEffect, useState } from 'react';
import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

import {
  ApiError,
  type PublicAppointmentConfirmationView,
  type PublicBookingContextView,
  type PublicPaymentAttemptView,
  type PublicProviderView,
  type PublicServiceView,
  type PublicStartView,
  createPublicAppointment,
  getPublicBookingContext,
  listPublicProviders,
  listPublicServices,
  listPublicStarts,
  recoverPublicPaymentAttempt,
} from '../api/client.js';
import { PublicPaymentCheckout } from './PublicPaymentCheckout.js';

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
  const [review, setReview] = useState<Record<string, string> | null>(null);
  const [confirmation, setConfirmation] = useState<PublicAppointmentConfirmationView | null>(null);
  const [paymentAttempt, setPaymentAttempt] = useState<PublicPaymentAttemptView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

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

  useEffect(() => {
    const match = /^\/book\/checkout\/([0-9a-f-]{36})$/iu.exec(window.location.pathname);
    if (!match?.[1]) return;
    setLoading(true);
    void recoverPublicPaymentAttempt(match[1])
      .then(setPaymentAttempt)
      .catch(() => {
        window.history.replaceState({}, '', '/book');
        setError('This secure checkout could not be recovered. Please start a new booking.');
      })
      .finally(() => setLoading(false));
  }, []);

  const chooseService = async (next: PublicServiceView) => {
    setService(next);
    setProvider(null);
    setDate('');
    setStarts([]);
    setSelectedStart(null);
    setReview(null);
    setConfirmation(null);
    setPaymentAttempt(null);
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
    setReview(null);
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
                  onClick={() => {
                    setSelectedStart(item);
                    setReview(null);
                    setConfirmation(null);
                    setPaymentAttempt(null);
                    setError(null);
                  }}
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

        {paymentAttempt && context.payment_checkout ? (
          <PublicPaymentCheckout
            attempt={paymentAttempt}
            publishableKey={context.payment_checkout.stripe_publishable_key}
            recover={() => recoverPublicPaymentAttempt(paymentAttempt.payment_attempt_public_id)}
            onUpdate={setPaymentAttempt}
            onRestart={(message) => {
              setPaymentAttempt(null);
              setReview(null);
              setSelectedStart(null);
              setIdempotencyKey(crypto.randomUUID());
              window.history.replaceState({}, '', '/book');
              setError(message);
            }}
          />
        ) : confirmation ? (
          <ConfirmationCard confirmation={confirmation} />
        ) : selectedStart && service && provider ? (
          <section className="public-booking-summary" aria-labelledby="booking-summary-title">
            <h2 id="booking-summary-title">
              {review ? 'Review your appointment' : 'Your details'}
            </h2>
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
            <p className="public-summary-price">
              {service.duration_minutes} minutes ·{' '}
              {money(service.base_price_minor, service.currency)}
            </p>
            {review ? (
              <div className="public-review-details">
                <p>
                  <strong>
                    {review.first_name} {review.last_name}
                  </strong>
                </p>
                <p>
                  {review.email} · {review.mobile_phone}
                </p>
                {review.appointment_note ? <p>Note: {review.appointment_note}</p> : null}
                <button type="button" className="text-button" onClick={() => setReview(null)}>
                  Edit details
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setSubmitting(true);
                    setError(null);
                    const requestBody = {
                      service_public_id: service.public_id,
                      provider_public_id: provider.public_id,
                      starts_at: selectedStart.starts_at,
                      customer: {
                        first_name: review.first_name,
                        last_name: review.last_name,
                        email: review.email,
                        mobile_phone: review.mobile_phone,
                        preferred_contact_channel: review.preferred_contact_channel,
                        customer_location_address:
                          service.delivery_mode === 'customer_location'
                            ? {
                                line_1: review.line_1,
                                line_2: review.line_2 || null,
                                city: review.city,
                                region: review.region,
                                postal_code: review.postal_code,
                                country_code: 'US',
                              }
                            : null,
                        appointment_note: review.appointment_note || null,
                      },
                      consent: {
                        booking_terms_version: context.booking_terms.version,
                        booking_terms_accepted: true,
                      },
                      ...(service.payment_mode &&
                      service.payment_mode !== 'none' &&
                      context.payment_checkout
                        ? {
                            payment_terms: {
                              version: context.payment_checkout.terms_version,
                              document_sha256: context.payment_checkout.terms_document_sha256,
                              accepted: review.payment_terms_accepted === 'on',
                            },
                          }
                        : {}),
                      website: '',
                    };
                    void createPublicAppointment(requestBody, idempotencyKey)
                      .then((result) => {
                        if ('payment_status' in result) {
                          window.history.replaceState(
                            {},
                            '',
                            `/book/checkout/${result.payment_attempt_public_id}`,
                          );
                          setPaymentAttempt(result);
                        } else setConfirmation(result);
                      })
                      .catch((reason: unknown) => {
                        if (
                          reason instanceof ApiError &&
                          reason.code === 'slot_no_longer_available'
                        ) {
                          setSelectedStart(null);
                          setReview(null);
                          setIdempotencyKey(crypto.randomUUID());
                          setError(
                            'That time was just taken. Please choose another available time.',
                          );
                        } else if (
                          reason instanceof ApiError &&
                          reason.code === 'booking_terms_changed'
                        ) {
                          setReview(null);
                          setError('The booking terms changed. Please review them and try again.');
                        } else if (
                          reason instanceof ApiError &&
                          ['payment_attempt_stale', 'payment_configuration_changed'].includes(
                            reason.code,
                          )
                        ) {
                          setReview(null);
                          setSelectedStart(null);
                          setIdempotencyKey(crypto.randomUUID());
                          setError(
                            'Booking details changed. Choose a current time and start a new checkout.',
                          );
                        } else if (
                          reason instanceof ApiError &&
                          [
                            'payment_execution_disabled',
                            'payment_execution_unavailable',
                            'payment_temporarily_unavailable',
                            'payment_account_not_ready',
                          ].includes(reason.code)
                        )
                          setError(
                            'Online payment is temporarily unavailable. No unpaid booking was created.',
                          );
                        else setError('Unable to book this appointment. Please try again.');
                      })
                      .finally(() => setSubmitting(false));
                  }}
                >
                  {service.payment_mode && service.payment_mode !== 'none'
                    ? submitting
                      ? 'Preparing secure checkout…'
                      : 'Continue to secure payment'
                    : submitting
                      ? 'Booking…'
                      : 'Book appointment'}
                </button>
              </div>
            ) : service.payment_mode &&
              service.payment_mode !== 'none' &&
              !context.payment_checkout ? (
              <p className="form-error" role="alert">
                Online payment is temporarily unavailable. This paid service cannot be booked as an
                unpaid appointment.
              </p>
            ) : (
              <GuestDetailsForm
                terms={context.booking_terms}
                paymentTerms={
                  !service.payment_mode || service.payment_mode === 'none'
                    ? null
                    : context.payment_checkout
                }
                deliveryMode={service.delivery_mode}
                onReview={(values) => {
                  setReview(values);
                  setIdempotencyKey(crypto.randomUUID());
                }}
              />
            )}
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

function GuestDetailsForm({
  terms,
  paymentTerms,
  deliveryMode,
  onReview,
}: {
  terms: PublicBookingContextView['booking_terms'];
  paymentTerms: PublicBookingContextView['payment_checkout'];
  deliveryMode: PublicServiceView['delivery_mode'];
  onReview: (values: Record<string, string>) => void;
}) {
  const [phone, setPhone] = useState('');
  return (
    <form
      className="public-guest-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onReview(
          Object.fromEntries(
            [...data.entries()].map(([key, value]) => [
              key,
              typeof value === 'string' ? value : '',
            ]),
          ),
        );
      }}
    >
      <div className="public-form-grid">
        <PublicField name="first_name" label="First name" autoComplete="given-name" required />
        <PublicField name="last_name" label="Last name" autoComplete="family-name" required />
        <PublicField name="email" label="Email" type="email" autoComplete="email" required />
        <PublicField
          name="mobile_phone"
          label="Mobile phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(843) 555-0123"
          required
          value={phone}
          onChange={(event) => setPhone(formatUsPhone(event.target.value))}
        />
      </div>
      <label>
        <span>How should the business contact you about this appointment?</span>
        <select name="preferred_contact_channel" defaultValue="email">
          <option value="email">Email</option>
          <option value="sms">Text message</option>
        </select>
      </label>
      {deliveryMode === 'customer_location' ? (
        <fieldset>
          <legend>Appointment address</legend>
          <PublicField name="line_1" label="Street address" autoComplete="address-line1" required />
          <PublicField
            name="line_2"
            label="Apartment or suite (optional)"
            autoComplete="address-line2"
          />
          <PublicField name="city" label="City" autoComplete="address-level2" required />
          <PublicField name="region" label="State" autoComplete="address-level1" required />
          <PublicField name="postal_code" label="ZIP code" autoComplete="postal-code" required />
        </fieldset>
      ) : null}
      <label>
        <span>Note for the business (optional)</span>
        <textarea name="appointment_note" maxLength={1000} />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" name="terms_accepted" required />
        <span>
          {terms.acknowledgment_label}{' '}
          {terms.terms_url ? (
            <a href={terms.terms_url} target="_blank" rel="noreferrer">
              Read terms
            </a>
          ) : null}
        </span>
      </label>
      {paymentTerms ? (
        <label className="checkbox-label">
          <input type="checkbox" name="payment_terms_accepted" required />
          <span>
            I accept the BookNowTech payment terms, including the amount disclosure and that the
            booking fee is normally non-refundable for a customer cancellation.
          </span>
        </label>
      ) : null}
      <label className="public-honeypot" aria-hidden="true">
        <span>Website</span>
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <button type="submit">Review appointment</button>
    </form>
  );
}

function PublicField(
  props: { name: string; label: string } & InputHTMLAttributes<HTMLInputElement>,
) {
  const { label, ...input } = props;
  return (
    <label>
      <span>{label}</span>
      <input {...input} />
    </label>
  );
}

function ConfirmationCard({ confirmation }: { confirmation: PublicAppointmentConfirmationView }) {
  return (
    <section
      className="public-booking-summary public-confirmation"
      aria-labelledby="confirmation-title"
    >
      <div className="public-confirmation-provider">
        <ConfirmationAvatar confirmation={confirmation} />
        <div>
          <h2 id="confirmation-title">You’re booked!</h2>
          <p>
            Your appointment with {confirmation.provider.display_name} at{' '}
            {confirmation.business.name} is confirmed.
          </p>
        </div>
      </div>
      <p>
        <strong>{confirmation.service.name}</strong>
      </p>
      <p>
        {new Date(confirmation.starts_at).toLocaleString([], {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: confirmation.timezone,
        })}
      </p>
      <p className="appointment-reference">
        Reference: <strong>{confirmation.appointment_reference}</strong>
      </p>
      <p>
        {confirmation.confirmation_email_queued
          ? 'We’ll send your appointment details to the email address you provided.'
          : 'Please save this reference or take a screenshot.'}
      </p>
    </section>
  );
}

function ConfirmationAvatar({ confirmation }: { confirmation: PublicAppointmentConfirmationView }) {
  const [failed, setFailed] = useState(false);
  if (confirmation.provider.photo_url && !failed)
    return (
      <img
        className="public-provider-avatar"
        src={confirmation.provider.photo_url}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  return (
    <span className="public-provider-avatar public-provider-initials" aria-hidden="true">
      {confirmation.provider.display_name.slice(0, 1).toUpperCase()}
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

// Progressively format US numbers as (XXX) XXX-XXXX for a consistent display.
// The API normalizes to E.164 server-side, so any format submitted is accepted.
function formatUsPhone(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 10);
  if (digits.length > 6) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length >= 3) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`.trimEnd();
  if (digits.length > 0) return `(${digits}`;
  return '';
}

function timeLabel(local: string) {
  const value = local.slice(11, 16);
  const [hourText, minute] = value.split(':');
  const hour = Number(hourText);
  if (!Number.isInteger(hour) || minute === undefined) return value;
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}
