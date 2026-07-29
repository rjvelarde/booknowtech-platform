import { useEffect, useState } from 'react';
import {
  ApiError,
  type AssignmentView,
  type AvailabilityExceptionView,
  type AvailabilityInterval,
  type AvailabilityScheduleView,
  type ProviderView,
  createAvailabilityException,
  getAvailabilitySchedule,
  getProvider,
  listAvailabilityExceptions,
  previewSchedulingSlots,
  saveAvailabilitySchedule,
  setAvailabilityExceptionActive,
  updateAssignmentBuffers,
} from '../api/client.js';

const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function AvailabilityPage({
  providerId,
  csrfToken,
  canManage,
  onNavigate,
}: {
  providerId: string;
  csrfToken: string;
  canManage: boolean;
  onNavigate: (path: string) => void;
}) {
  const [provider, setProvider] = useState<ProviderView | null>(null),
    [schedule, setSchedule] = useState<AvailabilityScheduleView | null>(null),
    [exceptions, setExceptions] = useState<AvailabilityExceptionView[]>([]);
  const [timezone, setTimezone] = useState('America/New_York'),
    [hours, setHours] = useState<AvailabilityInterval[]>([]),
    [breaks, setBreaks] = useState<AvailabilityInterval[]>([]),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      const p = await getProvider(providerId);
      setProvider(p);
      try {
        const s = await getAvailabilitySchedule(providerId);
        setSchedule(s);
        setTimezone(s.timezone);
        setHours(s.weekly_hours);
        setBreaks(s.breaks);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      setExceptions(await listAvailabilityExceptions(providerId));
    } catch {
      setError('Unable to load availability.');
    }
  };
  useEffect(() => {
    void load();
  }, [providerId]);
  const save = async () => {
    setError('');
    try {
      const next = await saveAvailabilitySchedule(
        providerId,
        {
          timezone,
          weekly_hours: hours,
          breaks,
          ...(schedule ? { expected_version: schedule.version } : {}),
        },
        csrfToken,
      );
      setSchedule(next);
      setMessage('Availability schedule saved.');
    } catch {
      setError('Unable to save availability. Check intervals and try again.');
    }
  };
  if (!provider)
    return <p role={error ? 'alert' : undefined}>{error || 'Loading availability…'}</p>;
  return (
    <section aria-labelledby="availability-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Provider availability</p>
          <h1 id="availability-title">{provider.display_name}</h1>
        </div>
        <button className="secondary-button" onClick={() => onNavigate(`/providers/${providerId}`)}>
          Back to provider
        </button>
      </div>
      {message ? (
        <p className="save-feedback success" role="status">
          <span aria-hidden="true">✓</span> {message}
        </p>
      ) : null}
      {error ? (
        <p className="save-feedback error" role="alert">
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
      <fieldset disabled={!canManage}>
        <legend>Weekly schedule</legend>
        <label>
          Timezone
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <IntervalEditor title="Working hours" items={hours} onChange={setHours} />
        <IntervalEditor title="Recurring breaks" items={breaks} onChange={setBreaks} />
        {canManage ? (
          <button type="button" onClick={() => void save()}>
            Save schedule
          </button>
        ) : null}
      </fieldset>
      <ExceptionEditor
        providerId={providerId}
        timezone={timezone}
        items={exceptions}
        canManage={canManage}
        csrfToken={csrfToken}
        reload={load}
      />
      <h2>Service buffers</h2>
      {provider.service_assignments?.length ? (
        <div className="service-list">
          {provider.service_assignments.map((a) => (
            <BufferRow
              key={a.public_id}
              providerId={providerId}
              assignment={a}
              canManage={canManage}
              csrfToken={csrfToken}
              reload={load}
            />
          ))}
        </div>
      ) : (
        <p>No service assignments.</p>
      )}
      <Preview provider={provider} />
    </section>
  );
}
function IntervalEditor({
  title,
  items,
  onChange,
}: {
  title: string;
  items: AvailabilityInterval[];
  onChange: (x: AvailabilityInterval[]) => void;
}) {
  return (
    <div>
      <h3>{title}</h3>
      {items.map((x, i) => (
        <div className="form-grid" key={i}>
          <label>
            Day
            <select
              value={x.day_of_week}
              onChange={(e) => replace(i, { ...x, day_of_week: Number(e.target.value) })}
            >
              {dayNames.slice(1).map((d, j) => (
                <option value={j + 1} key={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start
            <input
              type="time"
              value={time(x.start_minute)}
              onChange={(e) => replace(i, { ...x, start_minute: minutes(e.target.value) })}
            />
          </label>
          <label>
            End
            <input
              type="time"
              value={time(x.end_minute === 1440 ? 1439 : x.end_minute)}
              onChange={(e) => replace(i, { ...x, end_minute: endMinutes(e.target.value) })}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onChange(items.filter((_, index) => index !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          onChange([...items, { day_of_week: 1, start_minute: 540, end_minute: 1020 }])
        }
      >
        Add interval
      </button>
    </div>
  );
  function replace(index: number, value: AvailabilityInterval) {
    onChange(items.map((x, i) => (i === index ? value : x)));
  }
}
function ExceptionEditor({
  providerId,
  timezone,
  items,
  canManage,
  csrfToken,
  reload,
}: {
  providerId: string;
  timezone: string;
  items: AvailabilityExceptionView[];
  canManage: boolean;
  csrfToken: string;
  reload: () => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  return (
    <section>
      <h2>Time off and closures</h2>
      {canManage ? (
        <div className="form-grid">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Start date
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            End date (inclusive)
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <button
            type="button"
            onClick={() =>
              void createAvailabilityException(
                {
                  scope: 'provider',
                  provider_public_id: providerId,
                  kind: 'time_off',
                  name,
                  all_day: true,
                  timezone,
                  starts_on: start,
                  ends_before: addDay(end),
                },
                csrfToken,
              ).then(reload)
            }
          >
            Add time off
          </button>
        </div>
      ) : null}
      {items.map((x) => (
        <article className="service-card" key={x.public_id}>
          <div>
            <strong>{x.name ?? x.kind}</strong>
            <p>
              {x.starts_on ?? x.starts_at} to {x.ends_before ?? x.ends_at} · {x.status}
            </p>
          </div>
          {canManage ? (
            <button
              className="secondary-button"
              onClick={() =>
                void setAvailabilityExceptionActive(x, x.status !== 'active', csrfToken).then(
                  reload,
                )
              }
            >
              {x.status === 'active' ? 'Deactivate' : 'Activate'}
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
}
function BufferRow({
  providerId,
  assignment,
  canManage,
  csrfToken,
  reload,
}: {
  providerId: string;
  assignment: AssignmentView;
  canManage: boolean;
  csrfToken: string;
  reload: () => Promise<void>;
}) {
  const [before, setBefore] = useState(assignment.buffer_before_minutes ?? 0),
    [after, setAfter] = useState(assignment.buffer_after_minutes ?? 0);
  return (
    <article className="service-card">
      <div>
        <strong>{assignment.service.name}</strong>
        <div className="form-grid">
          <label>
            Before (minutes)
            <input
              type="number"
              min="0"
              max="1440"
              value={before}
              disabled={!canManage}
              onChange={(e) => setBefore(Number(e.target.value))}
            />
          </label>
          <label>
            After (minutes)
            <input
              type="number"
              min="0"
              max="1440"
              value={after}
              disabled={!canManage}
              onChange={(e) => setAfter(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
      {canManage ? (
        <button
          onClick={() =>
            void updateAssignmentBuffers(providerId, assignment, before, after, csrfToken).then(
              reload,
            )
          }
        >
          Save buffers
        </button>
      ) : null}
    </article>
  );
}
function Preview({ provider }: { provider: ProviderView }) {
  const assignment = provider.service_assignments?.find((x) => x.status === 'active');
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(today),
    [end, setEnd] = useState(today),
    [result, setResult] = useState<
      Awaited<ReturnType<typeof previewSchedulingSlots>>['data'] | null
    >(null),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  if (!assignment) return null;
  return (
    <section>
      <h2>Appointment start preview</h2>
      <p className="form-note">
        This preview shows theoretical starts only. It does not create or reserve appointments.
      </p>
      <div className="form-grid">
        <label>
          Start
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          End
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button
          onClick={() =>
            void previewSchedulingSlots(
              provider.public_id,
              assignment.service.public_id,
              start,
              end,
            ).then((page) => {
              setResult(page.data);
              setNextCursor(page.next_cursor);
            })
          }
        >
          Generate starts for {assignment.service.name}
        </button>
      </div>
      {result && !result.eligible ? (
        <p role="status">No starts are available: {result.reason?.replaceAll('_', ' ')}.</p>
      ) : null}
      {result?.eligible ? (
        <div className="service-list" aria-live="polite">
          <p role="status">
            {result.slots.length} theoretical start{result.slots.length === 1 ? '' : 's'} generated.
          </p>
          {result.slots.map((slot) => (
            <article className="service-card" key={slot.starts_at}>
              <div>
                <strong>{formatLocal(slot.local_start)}</strong>
                <p>Service ends {formatLocal(slot.local_service_end)}</p>
                <details>
                  <summary>Blocked-time details</summary>
                  <p>
                    Provider blocked from {formatLocal(slot.local_blocked_start)} through{' '}
                    {formatLocal(slot.local_blocked_end)}.
                  </p>
                </details>
              </div>
            </article>
          ))}
          {result.slots.length === 0 ? <p>No starts fit this date range.</p> : null}
          {nextCursor ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void previewSchedulingSlots(
                  provider.public_id,
                  assignment.service.public_id,
                  start,
                  end,
                  nextCursor,
                ).then((page) => {
                  setResult({ ...page.data, slots: [...result.slots, ...page.data.slots] });
                  setNextCursor(page.next_cursor);
                })
              }
            >
              Load more start times
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
function formatLocal(value: string) {
  return value.replace('T', ' ').replace(/:00([+-])/, '$1');
}
function time(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
function minutes(value: string) {
  const [h, m] = value.split(':').map(Number);
  return h! * 60 + m!;
}
function endMinutes(value: string) {
  return value === '23:59' ? 1440 : minutes(value);
}
function addDay(value: string) {
  if (!value) return '';
  return new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
    ? new Date(Date.parse(`${value}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
    : '';
}
