import { useEffect, useState } from 'react';

import {
  type ProviderInput,
  type ProviderView,
  type ServiceView,
  createProvider,
  createProviderAssignment,
  getProvider,
  listProviders,
  listServices,
  setAssignmentActive,
  setProviderActive,
  updateProvider,
} from '../api/client.js';

export function ProvidersPage({
  path,
  csrfToken,
  canManage,
  onNavigate,
}: {
  path: string;
  csrfToken: string;
  canManage: boolean;
  onNavigate: (path: string) => void;
}) {
  const match = /^\/providers\/([^/]+)(\/edit)?$/.exec(path);
  const publicId = match?.[1];
  const editing = path === '/providers/new' || Boolean(match?.[2]);
  if (path === '/providers')
    return <ProviderList canManage={canManage} csrfToken={csrfToken} onNavigate={onNavigate} />;
  return (
    <ProviderDetail
      publicId={publicId}
      editing={editing}
      canManage={canManage}
      csrfToken={csrfToken}
      onNavigate={onNavigate}
    />
  );
}

function ProviderList({
  canManage,
  csrfToken,
  onNavigate,
}: {
  canManage: boolean;
  csrfToken: string;
  onNavigate: (path: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const reload = (next = cursor) =>
    listProviders(status || undefined, next)
      .then((page) => {
        setProviders(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch(() => setError(true));
  useEffect(() => {
    setCursor(undefined);
    void reload(undefined);
  }, [status]);
  return (
    <section aria-labelledby="providers-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Team</p>
          <h1 id="providers-title">Providers</h1>
        </div>
        {canManage ? (
          <button type="button" onClick={() => onNavigate('/providers/new')}>
            Add provider
          </button>
        ) : null}
      </div>
      <label className="filter-label">
        Status{' '}
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </label>
      {error ? <p role="alert">Unable to complete the provider request.</p> : null}
      <div className="service-list">
        {providers.map((provider) => (
          <article className="service-card" key={provider.public_id}>
            <div className="provider-summary">
              {provider.photo_url ? (
                <img className="provider-photo" src={provider.photo_url} alt="" />
              ) : (
                <span className="provider-photo provider-initials" aria-hidden="true">
                  {initials(provider.display_name)}
                </span>
              )}
              <div>
                <small>{provider.internal_code ?? 'No internal code'}</small>
                <h2>{provider.display_name}</h2>
                <p>
                  {provider.accepting_new_clients
                    ? 'Accepting new clients'
                    : 'Not accepting new clients'}{' '}
                  · {provider.customer_selectable ? 'Customer selectable' : 'Business Hub only'}
                </p>
                <span className={`status-pill ${provider.status}`}>{provider.status}</span>
              </div>
            </div>
            <div className="card-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onNavigate(`/providers/${provider.public_id}`)}
              >
                View
              </button>
              {canManage ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void setProviderActive(provider, provider.status !== 'active', csrfToken)
                      .then(() => reload())
                      .catch(() => setError(true))
                  }
                >
                  {provider.status === 'active' ? 'Deactivate' : 'Activate'}
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {providers.length === 0 ? <p>No providers have been added.</p> : null}
      </div>
      {nextCursor ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setCursor(nextCursor);
            void reload(nextCursor);
          }}
        >
          Next providers
        </button>
      ) : null}
    </section>
  );
}

function ProviderDetail({
  publicId,
  editing,
  canManage,
  csrfToken,
  onNavigate,
}: {
  publicId: string | undefined;
  editing: boolean;
  canManage: boolean;
  csrfToken: string;
  onNavigate: (path: string) => void;
}) {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [services, setServices] = useState<ServiceView[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(false);
  const reload = () =>
    publicId
      ? getProvider(publicId)
          .then(setProvider)
          .catch(() => setError(true))
      : Promise.resolve();
  useEffect(() => {
    void reload();
    void listServices().then(setServices);
  }, [publicId]);
  if (editing && publicId && !provider)
    return (
      <p role={error ? 'alert' : undefined}>
        {error ? 'Unable to load provider.' : 'Loading provider…'}
      </p>
    );
  if (editing)
    return (
      <ProviderForm
        provider={provider}
        onCancel={() => onNavigate(provider ? `/providers/${provider.public_id}` : '/providers')}
        onSave={async (input) => {
          const saved = provider
            ? await updateProvider(
                provider.public_id,
                { ...input, expected_version: provider.version },
                csrfToken,
              )
            : await createProvider(input, csrfToken);
          onNavigate(`/providers/${saved.public_id}`);
        }}
      />
    );
  if (!provider)
    return (
      <p role={error ? 'alert' : undefined}>
        {error ? 'Unable to load provider.' : 'Loading provider…'}
      </p>
    );
  const assigned = new Set(provider.service_assignments?.map((item) => item.service.public_id));
  return (
    <section aria-labelledby="provider-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Provider</p>
          <h1 id="provider-title">{provider.display_name}</h1>
        </div>
        {canManage ? (
          <button type="button" onClick={() => onNavigate(`/providers/${provider.public_id}/edit`)}>
            Edit provider
          </button>
        ) : null}
      </div>
      <p>{provider.bio ?? 'No biography provided.'}</p>
      <dl className="detail-grid">
        <div>
          <dt>Status</dt>
          <dd>{provider.status}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{provider.email ?? '—'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{provider.phone ?? '—'}</dd>
        </div>
        <div>
          <dt>Display order</dt>
          <dd>{provider.display_order}</dd>
        </div>
        <div>
          <dt>Customer selectable</dt>
          <dd>{provider.customer_selectable ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Accepting new clients</dt>
          <dd>{provider.accepting_new_clients ? 'Yes' : 'No'}</dd>
        </div>
      </dl>
      {canManage ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            void setProviderActive(provider, provider.status !== 'active', csrfToken)
              .then(reload)
              .catch(() => setError(true))
          }
        >
          {provider.status === 'active' ? 'Deactivate provider' : 'Activate provider'}
        </button>
      ) : null}
      <h2>Service assignments</h2>
      {canManage ? (
        <div className="assignment-controls">
          <label>
            Service{' '}
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              <option value="">Select a service</option>
              {services
                .filter((service) => !assigned.has(service.public_id))
                .map((service) => (
                  <option key={service.public_id} value={service.public_id}>
                    {service.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!selected}
            onClick={() =>
              void createProviderAssignment(provider.public_id, selected, csrfToken)
                .then(() => {
                  setSelected('');
                  return reload();
                })
                .catch(() => setError(true))
            }
          >
            Assign service
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">Unable to complete the provider request.</p> : null}
      <div className="service-list">
        {provider.service_assignments?.map((assignment) => (
          <article className="service-card" key={assignment.public_id}>
            <div>
              <h3>{assignment.service.name}</h3>
              <p>
                {assignment.operationally_eligible
                  ? 'Operationally eligible'
                  : 'Not operationally eligible'}
              </p>
              <span className={`status-pill ${assignment.status}`}>{assignment.status}</span>
            </div>
            {canManage ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  void setAssignmentActive(
                    provider.public_id,
                    assignment,
                    assignment.status !== 'active',
                    csrfToken,
                  )
                    .then(reload)
                    .catch(() => setError(true))
                }
              >
                {assignment.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function ProviderForm({
  provider,
  onSave,
  onCancel,
}: {
  provider: ProviderView | null;
  onSave: (input: ProviderInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState(false);
  return (
    <form
      className="catalog-form"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void onSave({
          internal_code: nullable(values.get('internal_code')),
          display_name: text(values, 'display_name'),
          first_name: nullable(values.get('first_name')),
          last_name: nullable(values.get('last_name')),
          email: nullable(values.get('email')),
          phone: nullable(values.get('phone')),
          photo_url: nullable(values.get('photo_url')),
          bio: nullable(values.get('bio')),
          customer_selectable: values.get('customer_selectable') === 'on',
          accepting_new_clients: values.get('accepting_new_clients') === 'on',
          display_order: Number(values.get('display_order')),
        }).catch(() => setError(true));
      }}
    >
      <h2>{provider ? 'Edit provider' : 'Add provider'}</h2>
      {error ? <p role="alert">Unable to save provider.</p> : null}
      <Field
        label="Internal code"
        name="internal_code"
        value={provider?.internal_code ?? ''}
        pattern="[A-Za-z0-9._-]+"
      />
      <Field
        label="Display name"
        name="display_name"
        value={provider?.display_name ?? ''}
        required
      />
      <Field label="First name" name="first_name" value={provider?.first_name ?? ''} />
      <Field label="Last name" name="last_name" value={provider?.last_name ?? ''} />
      <Field label="Email" name="email" value={provider?.email ?? ''} type="email" />
      <Field
        label="Phone (E.164)"
        name="phone"
        value={provider?.phone ?? ''}
        pattern="\+[1-9][0-9]{1,14}"
      />
      <Field
        label="Photo URL (HTTPS)"
        name="photo_url"
        value={provider?.photo_url ?? ''}
        type="url"
        pattern="https://.*"
      />
      <label>
        <span>Biography</span>
        <textarea name="bio" defaultValue={provider?.bio ?? ''} maxLength={4000} />
      </label>
      <Field
        label="Display order"
        name="display_order"
        value={String(provider?.display_order ?? 0)}
        type="number"
        min="0"
        max="1000000"
      />
      <label className="checkbox-label">
        <input
          type="checkbox"
          name="customer_selectable"
          defaultChecked={provider?.customer_selectable ?? true}
        />{' '}
        Customer selectable
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          name="accepting_new_clients"
          defaultChecked={provider?.accepting_new_clients ?? true}
        />{' '}
        Accepting new clients
      </label>
      <div className="card-actions">
        <button type="submit">Save provider</button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function Field(props: {
  label: string;
  name: string;
  value: string;
  required?: boolean;
  type?: string;
  pattern?: string;
  min?: string;
  max?: string;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        name={props.name}
        defaultValue={props.value}
        required={props.required}
        type={props.type}
        pattern={props.pattern}
        min={props.min}
        max={props.max}
        maxLength={props.type === 'url' ? 2048 : undefined}
      />
    </label>
  );
}
function nullable(value: FormDataEntryValue | null) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || null;
}
function text(values: FormData, name: string) {
  const value = values.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}
