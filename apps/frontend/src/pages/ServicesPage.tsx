import { useEffect, useRef, useState } from 'react';

import {
  type ServiceInput,
  type ServiceView,
  createService,
  listServices,
  setServiceActive,
  updateService,
} from '../api/client.js';

export function ServicesPage({
  csrfToken,
  canManage,
  onNavigate,
}: {
  csrfToken: string;
  canManage: boolean;
  onNavigate: (path: string) => void;
}) {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [editing, setEditing] = useState<ServiceView | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(false);

  const reload = () =>
    listServices()
      .then(setServices)
      .catch(() => setError(true));
  useEffect(() => void reload(), []);

  return (
    <section aria-labelledby="services-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Catalog</p>
          <h1 id="services-title">Services</h1>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
          >
            Add service
          </button>
        ) : null}
      </div>
      <p className="form-note">
        Prices and booking fees are catalog values only; checkout calculations come later.
      </p>
      {error ? <p role="alert">Unable to complete the catalog request.</p> : null}
      {creating || editing ? (
        <ServiceForm
          service={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            if (editing)
              await updateService(
                editing.public_id,
                { ...input, expected_version: editing.version },
                csrfToken,
              );
            else await createService(input, csrfToken);
            setCreating(false);
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
      <div className="service-list">
        {services.map((service) => (
          <article className="service-card" key={service.public_id}>
            <div>
              <small>{service.internal_code ?? 'No internal code'}</small>
              <h2>{service.name}</h2>
              <p>
                {service.duration_minutes} minutes ·{' '}
                {money(service.base_price_minor, service.currency)} ·{' '}
                {money(service.booking_fee_minor, service.currency)} booking fee
              </p>
              <span className={`status-pill ${service.status}`}>{service.status}</span>
            </div>
            {canManage ? (
              <div className="card-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onNavigate(`/services/${service.public_id}`)}
                >
                  Providers
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setCreating(false);
                    setEditing(service);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void setServiceActive(service, service.status !== 'active', csrfToken)
                      .then(reload)
                      .catch(() => setError(true))
                  }
                >
                  {service.status === 'active' ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {services.length === 0 ? <p>No services have been added.</p> : null}
      </div>
    </section>
  );
}

function ServiceForm({
  service,
  onSave,
  onCancel,
}: {
  service: ServiceView | null;
  onSave: (input: ServiceInput) => Promise<void>;
  onCancel: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    headingRef.current?.focus({ preventScroll: true });
  }, [service]);

  return (
    <form
      className="catalog-form service-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void onSave({
          internal_code: nullable(values.get('internal_code')),
          name: formString(values, 'name'),
          description: nullable(values.get('description')),
          delivery_mode: formString(values, 'delivery_mode') as ServiceInput['delivery_mode'],
          duration_minutes: Number(values.get('duration_minutes')),
          base_price_minor: Math.round(Number(values.get('base_price')) * 100),
          booking_fee_minor: Math.round(Number(values.get('booking_fee')) * 100),
          slot_cadence_minutes: nullableNumber(values.get('slot_cadence_minutes')),
        });
      }}
    >
      <h2 ref={headingRef} tabIndex={-1}>
        {service ? `Edit ${service.name}` : 'Add service'}
      </h2>
      <label>
        <span>Internal code</span>
        <input
          name="internal_code"
          defaultValue={service?.internal_code ?? ''}
          pattern="[A-Za-z0-9._-]+"
          maxLength={64}
        />
      </label>
      <label>
        <span>Name</span>
        <input name="name" defaultValue={service?.name ?? ''} required maxLength={160} />
      </label>
      <label>
        <span>Description</span>
        <textarea name="description" defaultValue={service?.description ?? ''} maxLength={4000} />
      </label>
      <label>
        <span>Delivery</span>
        <select name="delivery_mode" defaultValue={service?.delivery_mode ?? 'provider_location'}>
          <option value="provider_location">Provider location</option>
          <option value="customer_location">Customer location</option>
          <option value="virtual">Virtual</option>
        </select>
      </label>
      <label>
        <span>Duration (minutes)</span>
        <input
          name="duration_minutes"
          type="number"
          min={5}
          max={1440}
          defaultValue={service?.duration_minutes ?? 30}
          required
        />
      </label>
      <label>
        <span>Appointment start interval</span>
        <select name="slot_cadence_minutes" defaultValue={service?.slot_cadence_minutes ?? ''}>
          <option value="">Use business default</option>
          {[5, 10, 15, 20, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              Every {minutes} minutes
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Service price</span>
        <input
          name="base_price"
          type="number"
          min={0}
          step="0.01"
          defaultValue={((service?.base_price_minor ?? 0) / 100).toFixed(2)}
          required
        />
      </label>
      <label>
        <span>Booking fee</span>
        <input
          name="booking_fee"
          type="number"
          min={0}
          step="0.01"
          defaultValue={((service?.booking_fee_minor ?? 0) / 100).toFixed(2)}
          required
        />
      </label>
      <div className="card-actions">
        <button type="submit">Save service</button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function nullable(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}
function nullableNumber(value: FormDataEntryValue | null): number | null {
  return typeof value === 'string' && value ? Number(value) : null;
}
function formString(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value : '';
}
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}
