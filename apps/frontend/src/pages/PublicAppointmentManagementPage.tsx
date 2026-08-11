import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

import {
  ApiError,
  type PublicManagedAppointmentView,
  type PublicStartView,
  cancelManagedAppointment,
  getManagedAppointment,
  listManagedReplacementStarts,
  rescheduleManagedAppointment,
} from '../api/client.js';

export interface ManagementCredential {
  tokenPublicId: string;
  credential: string;
}

export function captureManagementCredential(
  location: Location,
  history: History,
): ManagementCredential | null {
  const match = /^\/appointments\/manage\/([^/]+)$/.exec(location.pathname);
  const credential = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (!match?.[1] || !credential) return null;
  return { tokenPublicId: decodeURIComponent(match[1]), credential };
}

export function PublicAppointmentManagementPage() {
  const initial = useRef<ManagementCredential | null | undefined>(undefined);
  if (initial.current === undefined)
    initial.current = captureManagementCredential(window.location, window.history);
  const [access, setAccess] = useState<ManagementCredential | null>(initial.current);
  const [data, setData] = useState<PublicManagedAppointmentView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [unavailableMessage, setUnavailableMessage] = useState(
    'It may have expired or already been replaced. Please open the most recent appointment email or contact the business for assistance.',
  );
  const [mode, setMode] = useState<'summary' | 'reschedule' | 'cancel'>('summary');
  const [date, setDate] = useState('');
  const [starts, setStarts] = useState<PublicStartView[]>([]);
  const [selected, setSelected] = useState<PublicStartView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = async () => {
    if (!access) {
      setState('unavailable');
      return;
    }
    setState('loading');
    try {
      setData(await getManagedAppointment(access.tokenPublicId, access.credential));
      setState('ready');
    } catch (reason) {
      setUnavailableMessage(
        reason instanceof ApiError && reason.status === 429
          ? 'Too many requests. Wait a moment and try again.'
          : 'It may have expired or already been replaced. Please open the most recent appointment email or contact the business for assistance.',
      );
      setState('unavailable');
    }
  };
  useEffect(() => void load(), []);
  useEffect(() => {
    // Move focus to the heading on screen transitions (initial load, mode change).
    // Intentionally excludes `message`: the status region below is aria-live, so a
    // transient inline error is already announced — and focusing the heading on it
    // would steal focus from the date field while the user is mid-typing.
    if (state !== 'loading') headingRef.current?.focus({ preventScroll: true });
  }, [state, mode]);

  if (state === 'loading') return <ManagementStatus message="Loading your appointment…" />;
  if (state === 'unavailable' || !data || !access)
    return (
      <ManagementStatus
        headingRef={headingRef}
        title="This appointment link is no longer available"
        message={unavailableMessage}
        retry={() => void load()}
        alert
      />
    );

  const openMode = (next: 'summary' | 'reschedule' | 'cancel') => {
    setMode(next);
    setMessage(null);
    setSelected(null);
    setConfirmation('');
  };
  const loadStarts = async (startDate: string) => {
    setDate(startDate);
    setStarts([]);
    setSelected(null);
    setMessage(null);
    // A native date input reports partial years (e.g. 0002) while the year is
    // still being typed. Wait for a complete 4-digit year before calling the API,
    // so incomplete input no longer triggers an error (which previously stole
    // typing focus). Out-of-window complete dates are still validated by the API.
    if (!startDate || Number(startDate.slice(0, 4)) < 1000) return;
    setBusy(true);
    try {
      const result = await listManagedReplacementStarts(
        access.tokenPublicId,
        access.credential,
        startDate,
        addDays(startDate, 6),
      );
      setStarts(result.items);
      if (!result.items.length)
        setMessage('No replacement times are available in this seven-day window.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'Unable to load replacement times. Please retry.'));
    } finally {
      setBusy(false);
    }
  };
  const reschedule = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await rescheduleManagedAppointment(
        access.tokenPublicId,
        access.credential,
        data.appointment.version,
        selected.starts_at,
        crypto.randomUUID(),
      );
      const replacement = result.replacement;
      if (replacement) {
        setAccess({
          tokenPublicId: replacement.token_public_id,
          credential: replacement.credential,
        });
        window.history.replaceState(
          window.history.state,
          '',
          `/appointments/manage/${encodeURIComponent(replacement.token_public_id)}`,
        );
      }
      setData(result);
      setMode('summary');
      setMessage(
        "Your appointment has been successfully rescheduled.\n\nWe've emailed you an updated appointment confirmation with a new management link.",
      );
    } catch (reason) {
      setMessage(errorMessage(reason, 'That time is no longer available. Choose another time.'));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await cancelManagedAppointment(
        access.tokenPublicId,
        access.credential,
        data.appointment.version,
        crypto.randomUUID(),
      );
      setData(result);
      setMode('summary');
      setAccess({ ...access, credential: '' });
      setMessage('Your appointment was cancelled.');
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch (reason) {
      setMessage(errorMessage(reason, 'Unable to cancel this appointment. Please retry.'));
    } finally {
      setBusy(false);
    }
  };

  const startGroups = groupStartsByDay(starts);

  return (
    <main
      className="management-page"
      style={{ '--booking-accent': data.business.primary_color ?? '#1261A0' } as CSSProperties}
    >
      <section className="management-card" aria-labelledby="management-title">
        <Brand business={data.business} />
        <div className="management-content" aria-live="polite">
          <p className="eyebrow">Manage appointment</p>
          <h1 id="management-title" ref={headingRef} tabIndex={-1}>
            {mode === 'reschedule'
              ? 'Choose a new time'
              : mode === 'cancel'
                ? 'Cancel appointment'
                : data.appointment.service_name}
          </h1>
          {message ? (
            <>
              <div
                className={
                  message.includes('cancelled') || message.includes('rescheduled')
                    ? 'form-success'
                    : 'management-message'
                }
                role="status"
              >
                {message.split('\n\n').map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {!message.includes('cancelled') && !message.includes('rescheduled') ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    mode === 'reschedule' && date ? void loadStarts(date) : void load()
                  }
                >
                  Retry
                </button>
              ) : null}
            </>
          ) : null}
          {mode === 'summary' ? (
            <>
              <AppointmentSummary data={data} />
              {data.appointment.status === 'scheduled' ? (
                <div className="management-actions">
                  <button
                    type="button"
                    disabled={!data.actions.can_reschedule}
                    onClick={() => openMode('reschedule')}
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={!data.actions.can_cancel}
                    onClick={() => openMode('cancel')}
                  >
                    Cancel appointment
                  </button>
                </div>
              ) : (
                <p className="management-terminal">
                  This appointment is {data.appointment.status.replace('_', ' ')} and can no longer
                  be changed.
                </p>
              )}
              <CutoffMessage data={data} />
              <BusinessHelp business={data.business} />
            </>
          ) : mode === 'reschedule' ? (
            <fieldset className="management-flow" disabled={busy}>
              <legend>Find a replacement time</legend>
              <label>
                <span>Earliest date you’d like</span>
                <input
                  type="date"
                  value={date}
                  onChange={(event) => void loadStarts(event.target.value)}
                />
                <small className="form-note">We’ll show open times for the next 7 days.</small>
              </label>
              {busy ? <p role="status">Loading available times…</p> : null}
              <div
                className="management-time-groups"
                role="group"
                aria-label="Available replacement times"
              >
                {startGroups.map((group) => (
                  <div className="management-time-day" key={group.day}>
                    <h3 className="management-time-heading">
                      {formatDayHeading(group.heading.starts_at, group.heading.timezone)}
                    </h3>
                    <div className="management-time-grid">
                      {group.items.map((item) => (
                        <button
                          type="button"
                          key={item.starts_at}
                          aria-pressed={selected?.starts_at === item.starts_at}
                          aria-label={formatInstant(item.starts_at, item.timezone)}
                          className={selected?.starts_at === item.starts_at ? 'selected' : ''}
                          onClick={() => setSelected(item)}
                        >
                          {formatClockTime(item.starts_at, item.timezone)}
                          {selected?.starts_at === item.starts_at ? <span> ✓ Selected</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="management-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => openMode('summary')}
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!selected || busy}
                  onClick={() => void reschedule()}
                >
                  Confirm new time
                </button>
              </div>
            </fieldset>
          ) : (
            <fieldset className="management-flow cancel-panel" disabled={busy}>
              <legend>Confirm cancellation</legend>
              <p>
                This action cannot be undone. Type <strong>CANCEL</strong> to confirm.
              </p>
              <label>
                <span>Confirmation</span>
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </label>
              <div className="management-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => openMode('summary')}
                >
                  Keep appointment
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={confirmation !== 'CANCEL' || busy}
                  onClick={() => void cancel()}
                >
                  Cancel this appointment
                </button>
              </div>
            </fieldset>
          )}
        </div>
      </section>
    </main>
  );
}

function Brand({ business }: { business: PublicManagedAppointmentView['business'] }) {
  return (
    <header className="management-brand">
      {business.logo_url ? (
        <img src={business.logo_url} alt={`${business.name} logo`} />
      ) : (
        <div className="public-booking-initials" aria-hidden="true">
          {business.name[0]?.toUpperCase()}
        </div>
      )}
      <div>
        <strong>{business.name}</strong>
        {business.website ? (
          <div className="management-website">
            <a href={business.website}>Website</a>
          </div>
        ) : null}
      </div>
    </header>
  );
}
function AppointmentSummary({ data }: { data: PublicManagedAppointmentView }) {
  return (
    <dl className="management-summary">
      <div>
        <dt>Reference</dt>
        <dd>{data.appointment.reference}</dd>
      </div>
      <div>
        <dt>Provider</dt>
        <dd>{data.appointment.provider_name}</dd>
      </div>
      <div>
        <dt>Date and time</dt>
        <dd>{formatInstant(data.appointment.starts_at, data.appointment.timezone)}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{data.appointment.duration_minutes} minutes</dd>
      </div>
      <div>
        <dt>Timezone</dt>
        <dd>{formatTimezone(data.appointment.timezone)}</dd>
      </div>
    </dl>
  );
}
function BusinessHelp({ business }: { business: PublicManagedAppointmentView['business'] }) {
  if (!business.phone && !business.email) return null;
  return (
    <aside className="management-help" aria-labelledby="management-help-title">
      <h2 id="management-help-title">Need help?</h2>
      <div className="management-contact">
        {business.phone ? (
          <a href={`tel:${business.phone}`}>{formatPhone(business.phone)}</a>
        ) : null}
        {business.email ? <a href={`mailto:${business.email}`}>{business.email}</a> : null}
      </div>
    </aside>
  );
}
function CutoffMessage({ data }: { data: PublicManagedAppointmentView }) {
  if (!data.actions.can_reschedule && !data.actions.can_cancel)
    return (
      <p className="management-message">
        The change window for this appointment has closed. Contact the business for help.
      </p>
    );
  return (
    <p className="management-cutoff">
      Rescheduling is available until{' '}
      {formatInstant(data.actions.reschedule_until, data.appointment.timezone)}. Cancellation is
      available until {formatInstant(data.actions.cancel_until, data.appointment.timezone)}.
    </p>
  );
}
function ManagementStatus({
  message,
  title = 'Manage appointment',
  alert = false,
  retry,
  headingRef,
}: {
  message: string;
  title?: string;
  alert?: boolean;
  retry?: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <main className="management-page">
      <section className="management-card management-status" role={alert ? 'alert' : 'status'}>
        <p className="eyebrow">Manage appointment</p>
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <p>{message}</p>
        {retry ? (
          <button type="button" onClick={retry}>
            Try again
          </button>
        ) : null}
      </section>
    </main>
  );
}
function errorMessage(reason: unknown, fallback: string) {
  if (!(reason instanceof ApiError)) return fallback;
  if (reason.status === 404)
    return 'This appointment link is no longer available. Open the most recent email link.';
  if (reason.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (reason.code === 'version_conflict')
    return 'This appointment changed in another session. Reopen the most recent email link.';
  if (reason.code === 'action_unavailable')
    return 'The change cutoff has passed. Contact the business for help.';
  if (reason.code === 'start_unavailable')
    return 'That time is no longer available. Choose another time.';
  return fallback;
}
function formatInstant(value: string, timezone: string) {
  return new Intl.DateTimeFormat([], {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}
function formatDayHeading(value: string, timezone: string) {
  return new Intl.DateTimeFormat([], { dateStyle: 'full', timeZone: timezone }).format(
    new Date(value),
  );
}
function formatClockTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat([], { timeStyle: 'short', timeZone: timezone }).format(
    new Date(value),
  );
}
// Group chronologically-ordered starts into consecutive days so the grid can
// show one date heading with just the times beneath it, instead of repeating
// the full date on every button.
function groupStartsByDay(starts: PublicStartView[]) {
  const groups: { day: string; heading: PublicStartView; items: PublicStartView[] }[] = [];
  for (const item of starts) {
    const day = item.local_start.slice(0, 10);
    const current = groups.at(-1);
    if (current?.day === day) current.items.push(item);
    else groups.push({ day, heading: item, items: [item] });
  }
  return groups;
}
export function formatTimezone(timezone: string) {
  const value = new Date('2026-01-15T12:00:00.000Z');
  const longName = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longGeneric',
  })
    .formatToParts(value)
    .find((part) => part.type === 'timeZoneName')?.value;
  const shortName = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortGeneric',
  })
    .formatToParts(value)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (!longName) return timezone;
  return shortName && shortName !== longName ? `${longName} (${shortName})` : longName;
}
function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1'))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}
function addDays(date: string, count: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
