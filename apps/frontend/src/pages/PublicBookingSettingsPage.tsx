import { useEffect, useState } from 'react';
import type { InputHTMLAttributes } from 'react';

import {
  type AppointmentEmailSettingsView,
  type PublicBookingSettingsView,
  getAppointmentEmailSettings,
  getPublicBookingSettings,
  updateAppointmentEmailSettings,
  updatePublicBookingSettings,
} from '../api/client.js';

export function PublicBookingSettingsPage({
  csrfToken,
  canManage,
}: {
  csrfToken: string;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<PublicBookingSettingsView | null>(null);
  const [emailSettings, setEmailSettings] = useState<AppointmentEmailSettingsView | null>(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  useEffect(() => {
    void Promise.all([getPublicBookingSettings(), getAppointmentEmailSettings()])
      .then(([publicSettings, appointmentEmailSettings]) => {
        setSettings(publicSettings);
        setEmailSettings(appointmentEmailSettings);
      })
      .catch(() => setError(true));
  }, []);
  if (error) return <p role="alert">Unable to load public booking settings.</p>;
  if (!settings || !emailSettings) return <p>Loading public booking settings…</p>;
  return (
    <section aria-labelledby="public-booking-settings-title">
      <p className="eyebrow">Public discovery</p>
      <h1 id="public-booking-settings-title">Public booking page</h1>
      <p className="form-note">
        Preview hostname: <strong>{settings.fallback_hostname}</strong>. PR 9 is discovery only and
        does not accept appointments.
      </p>
      <form
        className="catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          const values = new FormData(event.currentTarget);
          void updatePublicBookingSettings(
            {
              expected_version: settings.version,
              public_booking_enabled: values.get('public_booking_enabled') === 'on',
              public_profile: {
                business_name: text(values, 'business_name'),
                description: nullable(values, 'description'),
                tagline: nullable(values, 'tagline'),
                logo_url: nullable(values, 'logo_url'),
                primary_color: nullable(values, 'primary_color'),
                website_url: nullable(values, 'website_url'),
                phone_e164: nullable(values, 'phone_e164'),
                email_normalized: nullable(values, 'email_normalized'),
              },
              booking_policy: {
                minimum_lead_minutes: Number(values.get('minimum_lead_minutes')),
                maximum_advance_days: Number(values.get('maximum_advance_days')),
              },
              public_booking_terms: {
                version: text(values, 'terms_version'),
                acknowledgment_label: text(values, 'terms_label'),
                terms_url: nullable(values, 'terms_url'),
              },
              appointment_self_service: {
                enabled: values.get('self_service_enabled') === 'on',
                cancellation_cutoff_minutes: Number(values.get('cancellation_cutoff_minutes')),
                reschedule_cutoff_minutes: Number(values.get('reschedule_cutoff_minutes')),
              },
            },
            csrfToken,
          )
            .then((next) => {
              setSettings(next);
              setEmailSettings((current) =>
                current ? { ...current, version: next.version } : current,
              );
              setSaved(true);
            })
            .catch(() => setError(true));
        }}
      >
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="public_booking_enabled"
            defaultChecked={settings.public_booking_enabled}
            disabled={!canManage}
          />
          <span>Publish this business for public discovery</span>
        </label>
        <Field
          name="business_name"
          label="Public business name"
          defaultValue={settings.public_profile.business_name}
          required
        />
        <Field
          name="tagline"
          label="Tagline"
          defaultValue={settings.public_profile.tagline ?? ''}
          maxLength={160}
        />
        <label>
          <span>Description</span>
          <textarea
            name="description"
            defaultValue={settings.public_profile.description ?? ''}
            maxLength={1000}
          />
        </label>
        <Field
          name="logo_url"
          label="Logo URL (HTTPS)"
          type="url"
          defaultValue={settings.public_profile.logo_url ?? ''}
        />
        <Field
          name="primary_color"
          label="Primary color"
          defaultValue={settings.public_profile.primary_color ?? ''}
          placeholder="#1261A0"
          pattern="#[A-Fa-f0-9]{6}"
        />
        <Field
          name="website_url"
          label="Public website (HTTPS)"
          type="url"
          defaultValue={settings.public_profile.website_url ?? ''}
        />
        <Field
          name="phone_e164"
          label="Public phone"
          defaultValue={settings.public_profile.phone_e164 ?? ''}
          placeholder="+18435551212"
        />
        <Field
          name="email_normalized"
          label="Public email"
          type="email"
          defaultValue={settings.public_profile.email_normalized ?? ''}
        />
        <Field
          name="minimum_lead_minutes"
          label="Minimum booking lead time (minutes)"
          type="number"
          min={0}
          max={43200}
          defaultValue={settings.booking_policy.minimum_lead_minutes}
          required
        />
        <Field
          name="maximum_advance_days"
          label="Maximum advance booking (days)"
          type="number"
          min={1}
          max={365}
          defaultValue={settings.booking_policy.maximum_advance_days}
          required
        />
        <Field
          name="terms_version"
          label="Booking terms version"
          defaultValue={settings.public_booking_terms.version}
          maxLength={64}
          required
        />
        <Field
          name="terms_label"
          label="Booking terms acknowledgment"
          defaultValue={settings.public_booking_terms.acknowledgment_label}
          maxLength={300}
          required
        />
        <Field
          name="terms_url"
          label="Booking terms URL (HTTPS)"
          type="url"
          defaultValue={settings.public_booking_terms.terms_url ?? ''}
        />
        <h2>Appointment self-service</h2>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="self_service_enabled"
            defaultChecked={settings.appointment_self_service.enabled}
            disabled={!canManage}
          />
          <span>Allow customers to reschedule or cancel from secure email links</span>
        </label>
        <Field
          name="reschedule_cutoff_minutes"
          label="Reschedule cutoff (minutes before start)"
          type="number"
          min={0}
          max={10080}
          defaultValue={settings.appointment_self_service.reschedule_cutoff_minutes}
          required
        />
        <Field
          name="cancellation_cutoff_minutes"
          label="Cancellation cutoff (minutes before start)"
          type="number"
          min={0}
          max={10080}
          defaultValue={settings.appointment_self_service.cancellation_cutoff_minutes}
          required
        />
        {canManage ? (
          <button type="submit">Save public booking settings</button>
        ) : (
          <p>View-only access</p>
        )}
        {saved ? (
          <p className="save-feedback success" role="status">
            Public booking settings saved.
          </p>
        ) : null}
      </form>
      <h2>Appointment emails</h2>
      <p className="form-note">
        Send branded appointment confirmations and lifecycle updates when a customer has an email
        address.
      </p>
      <form
        className="catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setEmailSaved(false);
          const values = new FormData(event.currentTarget);
          void updateAppointmentEmailSettings(
            {
              expected_version: emailSettings.version,
              enabled: values.get('email_enabled') === 'on',
              sender_name: text(values, 'sender_name'),
              reply_to_email: nullable(values, 'reply_to_email'),
            },
            csrfToken,
          )
            .then((next) => {
              setEmailSettings(next);
              setSettings((current) => (current ? { ...current, version: next.version } : current));
              setEmailSaved(true);
            })
            .catch(() => setError(true));
        }}
      >
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="email_enabled"
            defaultChecked={emailSettings.enabled}
            disabled={!canManage}
          />
          <span>Send transactional appointment emails</span>
        </label>
        <Field
          name="sender_name"
          label="Sender name"
          defaultValue={emailSettings.sender_name}
          required
        />
        <Field
          name="reply_to_email"
          label="Reply-to email"
          type="email"
          defaultValue={emailSettings.reply_to_email ?? ''}
        />
        {canManage ? <button type="submit">Save appointment email settings</button> : null}
        {emailSaved ? (
          <p className="save-feedback success" role="status">
            Appointment email settings saved.
          </p>
        ) : null}
      </form>
    </section>
  );
}

function Field(props: { label: string; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  const { label, ...input } = props;
  return (
    <label>
      <span>{label}</span>
      <input {...input} />
    </label>
  );
}
function text(values: FormData, name: string) {
  const value = values.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
function nullable(values: FormData, name: string) {
  return text(values, name) || null;
}
