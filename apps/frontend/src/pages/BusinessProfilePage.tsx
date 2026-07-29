import { useEffect, useState } from 'react';

import {
  type BusinessProfileView,
  getBusinessProfile,
  updateBusinessProfile,
} from '../api/client.js';

export function BusinessProfilePage({
  csrfToken,
  canManage,
}: {
  csrfToken: string;
  canManage: boolean;
}) {
  const [profile, setProfile] = useState<BusinessProfileView | null>(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getBusinessProfile()
      .then(setProfile)
      .catch(() => setError(true));
  }, []);

  if (error) return <p role="alert">Unable to load the business profile.</p>;
  if (!profile) return <p>Loading business profile…</p>;

  return (
    <section aria-labelledby="profile-title">
      <p className="eyebrow">Business settings</p>
      <h1 id="profile-title">Business profile</h1>
      <form
        className="catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          const values = new FormData(event.currentTarget);
          void updateBusinessProfile(
            {
              expected_version: profile.version,
              display_name: formString(values, 'display_name'),
              legal_name: nullable(values.get('legal_name')),
              contact: {
                email: nullable(values.get('email')),
                phone: nullable(values.get('phone')),
                website: nullable(values.get('website')),
              },
              default_timezone: formString(values, 'default_timezone'),
              default_slot_cadence_minutes: Number(values.get('default_slot_cadence_minutes')),
              locale: formString(values, 'locale'),
              currency: formString(values, 'currency').toUpperCase(),
            },
            csrfToken,
          )
            .then((next) => {
              setProfile(next);
              setSaved(true);
            })
            .catch(() => setError(true));
        }}
      >
        <Field
          label="Display name"
          name="display_name"
          defaultValue={profile.display_name}
          required
        />
        <label>
          <span>Default appointment start interval</span>
          <select
            name="default_slot_cadence_minutes"
            defaultValue={profile.default_slot_cadence_minutes}
          >
            {[5, 10, 15, 20, 30, 60].map((minutes) => (
              <option key={minutes} value={minutes}>
                Every {minutes} minutes
              </option>
            ))}
          </select>
        </label>
        <Field label="Legal name" name="legal_name" defaultValue={profile.legal_name ?? ''} />
        <Field label="Email" name="email" defaultValue={profile.contact.email ?? ''} type="email" />
        <Field label="Phone" name="phone" defaultValue={profile.contact.phone ?? ''} />
        <Field
          label="Website"
          name="website"
          defaultValue={profile.contact.website ?? ''}
          type="url"
        />
        <Field
          label="Time zone"
          name="default_timezone"
          defaultValue={profile.default_timezone}
          required
        />
        <Field label="Locale" name="locale" defaultValue={profile.locale} required />
        <Field
          label="Currency"
          name="currency"
          defaultValue={profile.currency}
          required
          maxLength={3}
        />
        <p className="form-note">Currency cannot be changed after the first service is created.</p>
        {canManage ? <button type="submit">Save profile</button> : <p>View-only access</p>}
        {saved ? <p role="status">Business profile saved.</p> : null}
      </form>
    </section>
  );
}

function Field({
  label,
  ...input
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label>
      <span>{label}</span>
      <input {...input} disabled={input.disabled} />
    </label>
  );
}

function nullable(value: FormDataEntryValue | null): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function formString(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value : '';
}
