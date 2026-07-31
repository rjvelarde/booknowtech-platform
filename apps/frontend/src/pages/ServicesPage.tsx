import { useEffect, useRef, useState } from 'react';

import {
  type ServiceInput,
  type ServiceView,
  createService,
  listServices,
  setServiceActive,
  updateService,
  updateServicePublicBooking,
} from '../api/client.js';

type ServiceFormInput = ServiceInput &
  Pick<ServiceView, 'publicly_bookable' | 'public_display_order' | 'public_booking_policy'>;

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
            const catalogInput: ServiceInput = {
              internal_code: input.internal_code,
              name: input.name,
              description: input.description,
              delivery_mode: input.delivery_mode,
              duration_minutes: input.duration_minutes,
              base_price_minor: input.base_price_minor,
              booking_fee_minor: input.booking_fee_minor,
              slot_cadence_minutes: input.slot_cadence_minutes,
            };
            const saved = editing
              ? await updateService(
                  editing.public_id,
                  { ...catalogInput, expected_version: editing.version },
                  csrfToken,
                )
              : await createService(catalogInput, csrfToken);
            await updateServicePublicBooking(
              saved,
              {
                publicly_bookable: input.publicly_bookable,
                public_display_order: input.public_display_order,
                public_booking_policy: input.public_booking_policy,
              },
              csrfToken,
            );
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
              <p>
                {service.publicly_bookable
                  ? 'Visible on public booking page'
                  : 'Not publicly bookable'}
              </p>
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
  onSave: (input: ServiceFormInput) => Promise<void>;
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
          publicly_bookable: values.get('publicly_bookable') === 'on',
          public_display_order: Number(values.get('public_display_order')),
          public_booking_policy: {
            minimum_lead_minutes: nullableNumber(values.get('public_minimum_lead_minutes')),
            maximum_advance_days: nullableNumber(values.get('public_maximum_advance_days')),
          },
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
      <fieldset>
        <legend>Public booking discovery</legend>
        <label className="checkbox-label">
          <input
            name="publicly_bookable"
            type="checkbox"
            defaultChecked={service?.publicly_bookable ?? false}
            disabled={service?.status === 'inactive'}
          />
          <span>Show this active service on the public booking page</span>
        </label>
        <label>
          <span>Public display order</span>
          <input
            name="public_display_order"
            type="number"
            min={0}
            max={100000}
            defaultValue={service?.public_display_order ?? 0}
            required
          />
        </label>
        <label>
          <span>Minimum lead time override (minutes)</span>
          <input
            name="public_minimum_lead_minutes"
            type="number"
            min={0}
            max={43200}
            defaultValue={service?.public_booking_policy.minimum_lead_minutes ?? ''}
            placeholder="Use business default"
          />
        </label>
        <label>
          <span>Maximum advance override (days)</span>
          <input
            name="public_maximum_advance_days"
            type="number"
            min={1}
            max={365}
            defaultValue={service?.public_booking_policy.maximum_advance_days ?? ''}
            placeholder="Use business default"
          />
        </label>
      </fieldset>
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
