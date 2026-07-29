import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  ApiError,
  type CustomerAddress,
  type CustomerInput,
  type CustomerView,
  type DuplicateCandidate,
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerActive,
  updateCustomer,
} from '../api/client.js';

interface Props {
  path: string;
  csrfToken: string;
  onNavigate: (path: string) => void;
}

export function CustomersPage(props: Props) {
  const match = props.path.match(/^\/customers\/([^/]+)(?:\/(edit))?$/);
  if (props.path === '/customers/new') return <CustomerForm {...props} />;
  if (match) {
    return match[2] ? (
      <CustomerForm {...props} publicId={match[1]!} />
    ) : (
      <CustomerDetail {...props} publicId={match[1]!} />
    );
  }
  return <CustomerDirectory {...props} />;
}

function CustomerDirectory({ onNavigate }: Props) {
  const [customers, setCustomers] = useState<CustomerView[]>([]);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = (append = false) => {
    void listCustomers({
      status,
      ...(query.trim().length >= 2 ? { q: query.trim() } : {}),
      ...(append && cursor ? { cursor } : {}),
    })
      .then((result) => {
        setCustomers((current) => (append ? [...current, ...result.items] : result.items));
        setCursor(result.next_cursor);
        setError(false);
      })
      .catch(() => setError(true));
  };
  useEffect(() => load(), [status]);

  return (
    <section aria-labelledby="customers-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Customers</p>
          <h2 id="customers-title">Customer directory</h2>
        </div>
        <button type="button" onClick={() => onNavigate('/customers/new')}>
          Add customer
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
          Search{' '}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, email, or phone"
          />
        </label>
        <label>
          Status{' '}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          Unable to load customers.
        </p>
      ) : null}
      <div className="catalog-list">
        {customers.map((customer) => (
          <article className="catalog-card" key={customer.public_id}>
            <div>
              <h3>{customer.display_name}</h3>
              <p>{customer.email ?? customer.mobile_phone ?? 'No contact details'}</p>
              <span className={`status-pill ${customer.status}`}>{customer.status}</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigate(`/customers/${customer.public_id}`)}
            >
              View
            </button>
          </article>
        ))}
      </div>
      {!customers.length && !error ? (
        <p className="empty-state">No customers match your search.</p>
      ) : null}
      {cursor ? (
        <button type="button" className="secondary-button" onClick={() => load(true)}>
          Load more
        </button>
      ) : null}
    </section>
  );
}

function CustomerDetail({ publicId, csrfToken, onNavigate }: Props & { publicId: string }) {
  const [customer, setCustomer] = useState<CustomerView | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void getCustomer(publicId)
      .then(setCustomer)
      .catch(() => setError(true));
  }, [publicId]);
  if (error)
    return (
      <p className="form-error" role="alert">
        Unable to load customer.
      </p>
    );
  if (!customer) return <p>Loading customer…</p>;
  const transition = async () =>
    setCustomer(await setCustomerActive(customer, customer.status !== 'active', csrfToken));
  return (
    <section aria-labelledby="customer-title">
      <button type="button" className="text-button" onClick={() => onNavigate('/customers')}>
        ← Customer directory
      </button>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Customer</p>
          <h2 id="customer-title">{customer.display_name}</h2>
        </div>
        <button type="button" onClick={() => onNavigate(`/customers/${publicId}/edit`)}>
          Edit customer
        </button>
      </div>
      <dl className="profile-grid">
        <div>
          <dt>Status</dt>
          <dd>{customer.status}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{customer.email ?? '—'}</dd>
        </div>
        <div>
          <dt>Mobile phone</dt>
          <dd>{customer.mobile_phone ?? '—'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{customer.source ?? '—'}</dd>
        </div>
      </dl>
      <button type="button" className="secondary-button" onClick={() => void transition()}>
        {customer.status === 'active' ? 'Deactivate customer' : 'Reactivate customer'}
      </button>
      <nav className="detail-tabs" aria-label="Reserved customer information">
        <button disabled>Appointments</button>
        <button disabled>Payments</button>
        <button disabled>Documents</button>
        <button disabled>Notes</button>
        <button disabled>Activity</button>
      </nav>
      <p className="status-copy">These sections will become available in future releases.</p>
    </section>
  );
}

const blankAddress = (): CustomerAddress => ({
  label: 'home',
  line_1: '',
  line_2: null,
  city: '',
  region: '',
  postal_code: '',
  country_code: 'US',
  is_primary: false,
});
const blankInput = (): CustomerInput => ({
  first_name: '',
  last_name: null,
  preferred_name: null,
  email: null,
  mobile_phone: null,
  addresses: [],
  communication_preferences: {
    preferred_channel: null,
    marketing_email: 'unknown',
    marketing_sms: 'unknown',
  },
});

function CustomerForm({ publicId, csrfToken, onNavigate }: Props & { publicId?: string }) {
  const [input, setInput] = useState<CustomerInput>(blankInput());
  const [version, setVersion] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    if (publicId)
      void getCustomer(publicId)
        .then((customer) => {
          setVersion(customer.version);
          setInput({
            first_name: customer.first_name,
            last_name: customer.last_name,
            preferred_name: customer.preferred_name,
            email: customer.email,
            mobile_phone: customer.mobile_phone,
            addresses: customer.addresses ?? [],
            communication_preferences: customer.communication_preferences!,
          });
        })
        .catch(() => setError('Unable to load customer.'));
  }, [publicId]);
  const field = (name: keyof CustomerInput, value: string) =>
    setInput((current) => ({ ...current, [name]: value || null }));
  const submit = async (acknowledge = false) => {
    setBusy(true);
    setError(null);
    try {
      const customer = publicId
        ? await updateCustomer(publicId, { ...input, expected_version: version }, csrfToken)
        : await createCustomer(
            { ...input, acknowledge_possible_duplicate: acknowledge },
            csrfToken,
          );
      onNavigate(`/customers/${customer.public_id}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'possible_duplicate')
        setDuplicates((reason.details?.candidates as DuplicateCandidate[] | undefined) ?? []);
      else
        setError(
          reason instanceof ApiError && reason.code === 'invalid_phone'
            ? 'Enter a valid US phone number.'
            : 'Unable to save customer. Please review the form and try again.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="customer-form-title">
      <button
        type="button"
        className="text-button"
        onClick={() => onNavigate(publicId ? `/customers/${publicId}` : '/customers')}
      >
        ← Cancel
      </button>
      <h2 id="customer-form-title" tabIndex={-1} ref={heading}>
        {publicId ? 'Edit customer' : 'Add customer'}
      </h2>
      {duplicates.length ? (
        <div className="form-warning" role="alert">
          <h3>Possible duplicate customer</h3>
          <p>Review these records before creating another:</p>
          <ul>
            {duplicates.map((item) => (
              <li key={item.public_id}>
                {item.display_name} — {item.reasons.join(', ')}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void submit(true)}>
            Create separate customer
          </button>
        </div>
      ) : null}
      <form
        className="catalog-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          First name{' '}
          <input
            required
            value={input.first_name}
            onChange={(event) => field('first_name', event.target.value)}
          />
        </label>
        <label>
          Last name{' '}
          <input
            value={input.last_name ?? ''}
            onChange={(event) => field('last_name', event.target.value)}
          />
        </label>
        <label>
          Preferred name{' '}
          <input
            value={input.preferred_name ?? ''}
            onChange={(event) => field('preferred_name', event.target.value)}
          />
        </label>
        <label>
          Email{' '}
          <input
            type="email"
            value={input.email ?? ''}
            onChange={(event) => field('email', event.target.value)}
          />
        </label>
        <label>
          US mobile phone{' '}
          <input
            type="tel"
            placeholder="(404) 555-0101"
            value={input.mobile_phone ?? ''}
            onChange={(event) => field('mobile_phone', event.target.value)}
          />
        </label>
        <label>
          Preferred contact{' '}
          <select
            value={input.communication_preferences.preferred_channel ?? ''}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                communication_preferences: {
                  ...current.communication_preferences,
                  preferred_channel: (event.target.value ||
                    null) as CustomerInput['communication_preferences']['preferred_channel'],
                },
              }))
            }
          >
            <option value="">Not specified</option>
            <option value="email">Email</option>
            <option value="sms">Text message</option>
            <option value="phone">Phone</option>
            <option value="none">None</option>
          </select>
        </label>
        <fieldset>
          <legend>Addresses</legend>
          {input.addresses.map((address, index) => (
            <div className="address-fields" key={address.public_id ?? index}>
              <label>
                Label{' '}
                <select
                  value={address.label}
                  onChange={(event) => changeAddress(index, 'label', event.target.value, setInput)}
                >
                  <option value="home">Home</option>
                  <option value="work">Work</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Street{' '}
                <input
                  required
                  value={address.line_1}
                  onChange={(event) => changeAddress(index, 'line_1', event.target.value, setInput)}
                />
              </label>
              <label>
                City{' '}
                <input
                  required
                  value={address.city}
                  onChange={(event) => changeAddress(index, 'city', event.target.value, setInput)}
                />
              </label>
              <label>
                State{' '}
                <input
                  required
                  value={address.region}
                  onChange={(event) => changeAddress(index, 'region', event.target.value, setInput)}
                />
              </label>
              <label>
                ZIP code{' '}
                <input
                  required
                  value={address.postal_code}
                  onChange={(event) =>
                    changeAddress(index, 'postal_code', event.target.value, setInput)
                  }
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setInput((current) => ({
                    ...current,
                    addresses: current.addresses.filter((_, itemIndex) => itemIndex !== index),
                  }))
                }
              >
                Remove address
              </button>
            </div>
          ))}
          {input.addresses.length < 5 ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                setInput((current) => ({
                  ...current,
                  addresses: [...current.addresses, blankAddress()],
                }))
              }
            >
              Add address
            </button>
          ) : null}
        </fieldset>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save customer'}
        </button>
      </form>
    </section>
  );
}

function changeAddress(
  index: number,
  key: keyof CustomerAddress,
  value: string,
  setInput: Dispatch<SetStateAction<CustomerInput>>,
) {
  setInput((current) => ({
    ...current,
    addresses: current.addresses.map((address, itemIndex) =>
      itemIndex === index ? { ...address, [key]: value } : address,
    ),
  }));
}
