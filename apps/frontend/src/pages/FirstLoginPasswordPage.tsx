import { type FormEvent, useEffect, useRef, useState } from 'react';

interface FirstLoginPasswordPageProps {
  busy: boolean;
  error: string | null;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export function FirstLoginPasswordPage({
  busy,
  error,
  onChangePassword,
}: FirstLoginPasswordPageProps) {
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => currentPasswordRef.current?.focus(), []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (newPassword !== confirmation) return;
    void onChangePassword(currentPassword, newPassword);
  };

  const mismatch = confirmation.length > 0 && newPassword !== confirmation;
  return (
    <main className="landing-page">
      <section className="landing-card" aria-labelledby="password-change-title">
        <div className="brand-mark" aria-hidden="true">
          B
        </div>
        <p className="eyebrow">BookNowTech</p>
        <h1 id="password-change-title">Set a new password</h1>
        <p className="status-copy">
          For your security, replace the temporary password before continuing.
        </p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="current-password">Temporary password</label>
          <input
            ref={currentPasswordRef}
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={16}
            required
            aria-describedby="password-requirements"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p id="password-requirements" className="form-help">
            Use at least 16 characters, including an uppercase letter, lowercase letter, and number.
          </p>
          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={mismatch}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {mismatch ? (
            <p className="form-error" role="alert">
              Passwords do not match.
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              Unable to change password. Check the temporary password and requirements, then try
              again.
            </p>
          ) : null}
          <button type="submit" disabled={busy || mismatch}>
            {busy ? 'Updating password…' : 'Continue'}
          </button>
        </form>
      </section>
    </main>
  );
}
