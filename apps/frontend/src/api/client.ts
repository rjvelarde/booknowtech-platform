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

export interface BusinessProfileView {
  public_id: string;
  slug: string;
  display_name: string;
  legal_name: string | null;
  contact: { email: string | null; phone: string | null; website: string | null };
  default_timezone: string;
  locale: string;
  currency: string;
  version: number;
  updated_at: string;
}

export interface ServiceView {
  public_id: string;
  internal_code: string | null;
  name: string;
  description: string | null;
  delivery_mode: 'provider_location' | 'customer_location' | 'virtual';
  duration_minutes: number;
  base_price_minor: number;
  booking_fee_minor: number;
  currency: string;
  status: 'active' | 'inactive';
  version: number;
}

export interface ProviderView {
  public_id: string;
  internal_code: string | null;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  bio: string | null;
  status: 'active' | 'inactive';
  customer_selectable: boolean;
  accepting_new_clients: boolean;
  display_order: number;
  version: number;
  service_assignments?: AssignmentView[];
}

export interface AssignmentView {
  public_id: string;
  status: 'active' | 'inactive';
  version: number;
  provider: Pick<
    ProviderView,
    'public_id' | 'display_name' | 'status' | 'customer_selectable' | 'accepting_new_clients'
  >;
  service: Pick<ServiceView, 'public_id' | 'name' | 'status'>;
  operationally_eligible: boolean;
}

export type ProviderInput = Pick<
  ProviderView,
  | 'internal_code'
  | 'display_name'
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'photo_url'
  | 'bio'
  | 'customer_selectable'
  | 'accepting_new_clients'
  | 'display_order'
>;

export type ServiceInput = Pick<
  ServiceView,
  | 'internal_code'
  | 'name'
  | 'description'
  | 'delivery_mode'
  | 'duration_minutes'
  | 'base_price_minor'
  | 'booking_fee_minor'
>;

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

export function getBusinessProfile(): Promise<BusinessProfileView> {
  return request('/v1/admin/business-profile');
}

export function updateBusinessProfile(
  input: Partial<Omit<BusinessProfileView, 'public_id' | 'slug' | 'updated_at'>> & {
    expected_version: number;
  },
  csrfToken: string,
): Promise<BusinessProfileView> {
  return request('/v1/admin/business-profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function listServices(): Promise<ServiceView[]> {
  return request('/v1/admin/services');
}

export function getService(publicId: string): Promise<ServiceView> {
  return request(`/v1/admin/services/${publicId}`);
}

export function listProviders(
  status?: 'active' | 'inactive',
  cursor?: string,
): Promise<{ items: ProviderView[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  return request(`/v1/admin/providers${query.size ? `?${query.toString()}` : ''}`);
}

export function getProvider(publicId: string): Promise<ProviderView> {
  return request(`/v1/admin/providers/${publicId}`);
}

export function createProvider(input: ProviderInput, csrfToken: string): Promise<ProviderView> {
  return request('/v1/admin/providers', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function updateProvider(
  publicId: string,
  input: Partial<ProviderInput> & { expected_version: number },
  csrfToken: string,
): Promise<ProviderView> {
  return request(`/v1/admin/providers/${publicId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function setProviderActive(
  provider: ProviderView,
  active: boolean,
  csrfToken: string,
): Promise<ProviderView & { changed: boolean }> {
  return request(
    `/v1/admin/providers/${provider.public_id}/${active ? 'activate' : 'deactivate'}`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_version: provider.version }),
      headers: { 'x-csrf-token': csrfToken },
    },
  );
}

export function createProviderAssignment(
  providerId: string,
  serviceId: string,
  csrfToken: string,
): Promise<AssignmentView & { changed: boolean }> {
  return request(`/v1/admin/providers/${providerId}/service-assignments`, {
    method: 'POST',
    body: JSON.stringify({ service_public_id: serviceId }),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function setAssignmentActive(
  providerId: string,
  assignment: AssignmentView,
  active: boolean,
  csrfToken: string,
): Promise<AssignmentView & { changed: boolean }> {
  return request(
    `/v1/admin/providers/${providerId}/service-assignments/${assignment.public_id}/${active ? 'activate' : 'deactivate'}`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_version: assignment.version }),
      headers: { 'x-csrf-token': csrfToken },
    },
  );
}

export function listServiceProviderAssignments(serviceId: string): Promise<AssignmentView[]> {
  return request(`/v1/admin/services/${serviceId}/provider-assignments`);
}

export function createService(input: ServiceInput, csrfToken: string): Promise<ServiceView> {
  return request('/v1/admin/services', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function updateService(
  publicId: string,
  input: Partial<ServiceInput> & { expected_version: number },
  csrfToken: string,
): Promise<ServiceView> {
  return request(`/v1/admin/services/${publicId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function setServiceActive(
  service: ServiceView,
  active: boolean,
  csrfToken: string,
): Promise<ServiceView & { changed: boolean }> {
  return request(`/v1/admin/services/${service.public_id}/${active ? 'activate' : 'deactivate'}`, {
    method: 'POST',
    body: JSON.stringify({ expected_version: service.version }),
    headers: { 'x-csrf-token': csrfToken },
  });
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
