import { type FormEvent, useState } from 'react';

interface LoginPageProps {
  busy: boolean;
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
}

export function LoginPage({ busy, error, onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onLogin(email, password);
  };

  return (
    <main className="landing-page">
      <section className="landing-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">
          B
        </div>
        <p className="eyebrow">BookNowTech</p>
        <h1 id="login-title">Business Hub</h1>
        <p className="status-copy">Sign in to run your business.</p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? (
            <p className="form-error" role="alert">
              Unable to sign in. Check your credentials and try again.
            </p>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
