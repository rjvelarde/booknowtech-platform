import { useEffect, useState } from 'react';
import { isAdministrativeHostname } from '@booknowtech/shared/hostname';

import {
  type AdminSessionView,
  ApiError,
  changePassword,
  hydrateSession,
  login,
  logout,
  selectMembership,
} from './api/client.js';
import { BusinessHubHomePage } from './pages/BusinessHubHomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { FirstLoginPasswordPage } from './pages/FirstLoginPasswordPage.js';
import { BusinessProfilePage } from './pages/BusinessProfilePage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { ProvidersPage } from './pages/ProvidersPage.js';
import { ServiceProviderAssignmentsPage } from './pages/ServiceProviderAssignmentsPage.js';
import { TenantSelectionPage } from './pages/TenantSelectionPage.js';
import { AvailabilityPage } from './pages/AvailabilityPage.js';
import { ClosuresPage } from './pages/ClosuresPage.js';
import { CustomersPage } from './pages/CustomersPage.js';
import { AppointmentsPage } from './pages/AppointmentsPage.js';
import { PublicBookingPage } from './pages/PublicBookingPage.js';
import { PublicBookingSettingsPage } from './pages/PublicBookingSettingsPage.js';
import { PublicAppointmentManagementPage } from './pages/PublicAppointmentManagementPage.js';
import { loadPublicEnvironment } from './config.js';

type View = 'loading' | 'placeholder' | 'login' | 'password' | 'select' | 'hub' | 'denied';

export function App() {
  const publicEnvironment = loadPublicEnvironment(
    import.meta.env.MODE === 'test'
      ? {
          VITE_API_BASE_URL: '/api',
          VITE_BOOKING_ROOT_DOMAIN: 'booknowtech.com',
          VITE_BUILD_VERSION: '0'.repeat(40),
        }
      : import.meta.env,
  );
  if (isPublicBookingHost(window.location.hostname, publicEnvironment.VITE_BOOKING_ROOT_DOMAIN))
    return window.location.pathname.startsWith('/appointments/manage/') ? (
      <PublicAppointmentManagementPage />
    ) : (
      <PublicBookingPage />
    );
  const [view, setView] = useState<View>('loading');
  const [session, setSession] = useState<AdminSessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    void hydrateSession()
      .then((next) => applySession(next, setSession, setView))
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 404) setView('placeholder');
        else if (reason instanceof ApiError && reason.status === 401) setView('login');
        else setView('login');
      });
  }, []);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleLogin = async (email: string, password: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      applySession(await login(email, password), setSession, setView);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (membershipPublicId: string): Promise<void> => {
    if (!session) return;
    setBusy(true);
    try {
      applySession(
        await selectMembership(membershipPublicId, session.csrf_token),
        setSession,
        setView,
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordChange = async (
    currentPassword: string,
    newPassword: string,
  ): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      applySession(
        await changePassword(currentPassword, newPassword, session.csrf_token),
        setSession,
        setView,
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setLogoutError(null);
    try {
      await logout(session.csrf_token);
      setSession(null);
      setView('login');
    } catch (reason) {
      setLogoutError(reason instanceof ApiError ? reason.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  };

  if (view === 'loading') return <StatusCard message="Loading Business Hub…" />;
  if (view === 'placeholder')
    return <StatusCard message="The Business Hub is being prepared for launch." />;
  if (view === 'login') return <LoginPage busy={busy} error={error} onLogin={handleLogin} />;
  if (view === 'password' && session)
    return (
      <FirstLoginPasswordPage busy={busy} error={error} onChangePassword={handlePasswordChange} />
    );
  if (view === 'denied' || !session)
    return <StatusCard message="Your account does not have an active business membership." />;
  if (view === 'select')
    return <TenantSelectionPage session={session} busy={busy} onSelect={handleSelect} />;
  return (
    <BusinessHubHomePage
      session={session}
      busy={busy}
      error={logoutError}
      onSwitch={() => setView('select')}
      onLogout={handleLogout}
      onNavigate={(next) => {
        window.history.pushState({}, '', next);
        setPath(next);
      }}
    >
      {path === '/business' ? (
        <BusinessProfilePage csrfToken={session.csrf_token} canManage={canManage(session)} />
      ) : null}
      {path === '/public-booking' ? (
        <PublicBookingSettingsPage csrfToken={session.csrf_token} canManage={canManage(session)} />
      ) : null}
      {path === '/services' ? (
        <ServicesPage
          csrfToken={session.csrf_token}
          canManage={canManage(session)}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
      {path.startsWith('/services/') ? (
        <ServiceProviderAssignmentsPage
          publicId={path.split('/')[2]!}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
      {path.match(/^\/providers\/[^/]+\/availability$/) ? (
        <AvailabilityPage
          providerId={path.split('/')[2]!}
          csrfToken={session.csrf_token}
          canManage={canManage(session)}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
      {path === '/availability/closures' ? (
        <ClosuresPage csrfToken={session.csrf_token} canManage={canManage(session)} />
      ) : null}
      {(path === '/providers' || path.startsWith('/providers/')) &&
      !path.endsWith('/availability') ? (
        <ProvidersPage
          path={path}
          csrfToken={session.csrf_token}
          canManage={canManage(session)}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
      {path.startsWith('/customers') && session.active_tenant?.role !== 'provider' ? (
        <CustomersPage
          path={path}
          csrfToken={session.csrf_token}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
      {path.startsWith('/appointments') && session.active_tenant?.role !== 'provider' ? (
        <AppointmentsPage
          path={path}
          csrfToken={session.csrf_token}
          role={session.active_tenant!.role}
          onNavigate={(next) => navigate(next, setPath)}
        />
      ) : null}
    </BusinessHubHomePage>
  );
}

export function isPublicBookingHost(
  hostname: string,
  bookingRootDomain: 'booknowtech.com' | 'staging.booknowtech.com' = 'booknowtech.com',
): boolean {
  return !isAdministrativeHostname(hostname, bookingRootDomain);
}

function navigate(path: string, setPath: (path: string) => void): void {
  window.history.pushState({}, '', path);
  setPath(path);
}

function canManage(session: AdminSessionView): boolean {
  return (
    session.active_tenant?.role === 'tenant_owner' || session.active_tenant?.role === 'tenant_admin'
  );
}

function applySession(
  session: AdminSessionView,
  setSession: (session: AdminSessionView) => void,
  setView: (view: View) => void,
): void {
  setSession(session);
  if (session.must_change_password) setView('password');
  else if (session.active_tenant) setView('hub');
  else if (session.memberships.length > 0) setView('select');
  else setView('denied');
}

function StatusCard({ message }: { message: string }) {
  return (
    <main className="landing-page">
      <section className="landing-card" aria-labelledby="product-title">
        <div className="brand-mark" aria-hidden="true">
          B
        </div>
        <p className="eyebrow">BookNowTech</p>
        <h1 id="product-title">Business Hub</h1>
        <p className="status-copy">{message}</p>
      </section>
    </main>
  );
}
