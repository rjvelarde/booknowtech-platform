import { loadPublicEnvironment } from '../config.js';

export interface MembershipView {
  public_id: string;
  role: string;
  tenant: { public_id: string; display_name: string };
}

export interface AdminSessionView {
  user: { public_id: string; display_name: string };
  active_tenant: { public_id: string; display_name: string; role: string } | null;
  memberships: MembershipView[];
  csrf_token: string;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

const baseUrl = loadPublicEnvironment(
  import.meta.env.MODE === 'test' ? { VITE_API_BASE_URL: '/api' } : import.meta.env,
).VITE_API_BASE_URL;

export async function hydrateSession(): Promise<AdminSessionView> {
  return request('/v1/auth/session');
}

export async function login(email: string, password: string): Promise<AdminSessionView> {
  return request('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function selectMembership(
  membershipPublicId: string,
  csrfToken: string,
): Promise<AdminSessionView> {
  return request('/v1/auth/select-membership', {
    method: 'POST',
    body: JSON.stringify({ membership_public_id: membershipPublicId }),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export async function logout(csrfToken: string): Promise<void> {
  await request('/v1/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-request-id': crypto.randomUUID(),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed');
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as { data: T };
  return body.data;
}
