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
  default_slot_cadence_minutes: number;
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
  slot_cadence_minutes: number | null;
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
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  provider: Pick<
    ProviderView,
    'public_id' | 'display_name' | 'status' | 'customer_selectable' | 'accepting_new_clients'
  >;
  service: Pick<ServiceView, 'public_id' | 'name' | 'status'>;
  operationally_eligible: boolean;
}
export interface AvailabilityInterval {
  day_of_week: number;
  start_minute: number;
  end_minute: number;
}
export interface AvailabilityScheduleView {
  public_id: string;
  timezone: string;
  weekly_hours: AvailabilityInterval[];
  breaks: AvailabilityInterval[];
  version: number;
  updated_at: string;
}
export interface AvailabilityExceptionView {
  public_id: string;
  scope: 'tenant' | 'provider';
  kind: 'holiday' | 'closure' | 'time_off';
  name: string | null;
  all_day: boolean;
  timezone: string;
  starts_on: string | null;
  ends_before: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: 'active' | 'inactive';
  version: number;
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
  | 'slot_cadence_minutes'
>;

export interface SchedulingSlotView {
  starts_at: string;
  service_ends_at: string;
  blocked_starts_at: string;
  blocked_ends_at: string;
  local_start: string;
  local_service_end: string;
  local_blocked_start: string;
  local_blocked_end: string;
}

export interface SchedulingSlotsView {
  eligible: boolean;
  reason?: string;
  timezone: string;
  booking_policy_enforced: false;
  service: { public_id: string; duration_minutes: number; slot_cadence_minutes: number };
  assignment: {
    public_id: string;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
  };
  slots: SchedulingSlotView[];
}

export interface CustomerAddress {
  public_id?: string;
  label: 'home' | 'work' | 'other';
  line_1: string;
  line_2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  is_primary: boolean;
}

export interface CustomerView {
  public_id: string;
  display_name: string;
  first_name: string;
  last_name: string | null;
  preferred_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  addresses?: CustomerAddress[];
  communication_preferences?: {
    preferred_channel: 'email' | 'sms' | 'phone' | 'none' | null;
    marketing_email: 'unknown' | 'opted_in' | 'opted_out';
    marketing_sms: 'unknown' | 'opted_in' | 'opted_out';
  };
  source?: string;
  status: 'active' | 'inactive';
  version: number;
  updated_at: string;
}

export interface CustomerInput {
  first_name: string;
  last_name: string | null;
  preferred_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  addresses: CustomerAddress[];
  communication_preferences: {
    preferred_channel: 'email' | 'sms' | 'phone' | 'none' | null;
    marketing_email: 'unknown' | 'opted_in' | 'opted_out';
    marketing_sms: 'unknown' | 'opted_in' | 'opted_out';
  };
}

export interface DuplicateCandidate {
  public_id: string;
  display_name: string;
  email: string | null;
  mobile_phone: string | null;
  status: 'active' | 'inactive';
  reasons: string[];
}

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

export interface AppointmentView {
  public_id: string;
  reference: string;
  customer: { public_id?: string | null; display_name: string };
  provider: { public_id?: string | null; display_name: string };
  service: { public_id?: string | null; name: string };
  starts_at: string;
  ends_at: string;
  blocked_starts_at?: string;
  blocked_ends_at?: string;
  timezone: string;
  local_start_date: string;
  status: AppointmentStatus;
  version: number;
  snapshot?: {
    service_duration_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    base_price_minor: number;
    booking_fee_minor: number;
    currency: string;
  };
  cancellation_reason?: string | null;
  cancellation_detail?: string | null;
}

export function listAppointments(
  input: {
    view?: 'today' | 'upcoming' | 'past';
    status?: AppointmentStatus;
    customer_query?: string;
    reference?: string;
  } = {},
): Promise<{ items: AppointmentView[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => value && query.set(key, value));
  return request(`/v1/admin/appointments${query.size ? `?${query.toString()}` : ''}`);
}

export function getAppointment(publicId: string): Promise<AppointmentView> {
  return request(`/v1/admin/appointments/${publicId}`);
}

export function createAppointment(
  input: {
    customer_public_id: string;
    provider_public_id: string;
    service_public_id: string;
    starts_at: string;
    customer_address_public_id?: string;
  },
  csrfToken: string,
): Promise<AppointmentView> {
  return request('/v1/admin/appointments', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function rescheduleAppointment(
  item: AppointmentView,
  startsAt: string,
  csrfToken: string,
): Promise<AppointmentView & { changed: boolean }> {
  return appointmentAction(item, 'reschedule', { starts_at: startsAt }, csrfToken);
}

export function transitionAppointment(
  item: AppointmentView,
  action: 'cancel' | 'complete' | 'no-show',
  input: { reason?: string; detail?: string | null; early_override?: boolean } = {},
  csrfToken: string,
): Promise<AppointmentView & { changed: boolean }> {
  return appointmentAction(item, action, input, csrfToken);
}

function appointmentAction<T extends Record<string, unknown>>(
  item: AppointmentView,
  action: string,
  input: T,
  csrfToken: string,
): Promise<AppointmentView & { changed: boolean }> {
  return request(`/v1/admin/appointments/${item.public_id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ expected_version: item.version, ...input }),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export function listCustomers(
  input: {
    status?: 'active' | 'inactive' | 'all';
    q?: string;
    cursor?: string;
  } = {},
): Promise<{ items: CustomerView[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (input.status) query.set('status', input.status);
  if (input.q) query.set('q', input.q);
  if (input.cursor) query.set('cursor', input.cursor);
  return request(`/v1/admin/customers${query.size ? `?${query.toString()}` : ''}`);
}

export function getCustomer(publicId: string): Promise<CustomerView> {
  return request(`/v1/admin/customers/${publicId}`);
}

export function createCustomer(
  input: CustomerInput & { acknowledge_possible_duplicate?: boolean },
  csrfToken: string,
): Promise<CustomerView> {
  return request('/v1/admin/customers', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function updateCustomer(
  publicId: string,
  input: CustomerInput & { expected_version: number },
  csrfToken: string,
): Promise<CustomerView & { changed: boolean }> {
  return request(`/v1/admin/customers/${publicId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}

export function setCustomerActive(
  customer: CustomerView,
  active: boolean,
  csrfToken: string,
): Promise<CustomerView & { changed: boolean }> {
  return request(
    `/v1/admin/customers/${customer.public_id}/${active ? 'activate' : 'deactivate'}`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_version: customer.version }),
      headers: { 'x-csrf-token': csrfToken },
    },
  );
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
export function getAvailabilitySchedule(providerId: string): Promise<AvailabilityScheduleView> {
  return request(`/v1/admin/providers/${providerId}/availability-schedule`);
}
export function saveAvailabilitySchedule(
  providerId: string,
  input: {
    timezone: string;
    weekly_hours: AvailabilityInterval[];
    breaks: AvailabilityInterval[];
    expected_version?: number;
  },
  csrfToken: string,
): Promise<AvailabilityScheduleView> {
  return request(`/v1/admin/providers/${providerId}/availability-schedule`, {
    method: input.expected_version ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}
export function listAvailabilityExceptions(
  providerId?: string,
): Promise<AvailabilityExceptionView[]> {
  return request(
    `/v1/admin/availability-exceptions${providerId ? `?provider_public_id=${encodeURIComponent(providerId)}` : ''}`,
  );
}
export function createAvailabilityException(
  input: Record<string, unknown>,
  csrfToken: string,
): Promise<AvailabilityExceptionView> {
  return request('/v1/admin/availability-exceptions', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'x-csrf-token': csrfToken },
  });
}
export function setAvailabilityExceptionActive(
  item: AvailabilityExceptionView,
  active: boolean,
  csrfToken: string,
): Promise<AvailabilityExceptionView & { changed: boolean }> {
  return request(
    `/v1/admin/availability-exceptions/${item.public_id}/${active ? 'activate' : 'deactivate'}`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_version: item.version }),
      headers: { 'x-csrf-token': csrfToken },
    },
  );
}
export function updateAssignmentBuffers(
  providerId: string,
  item: AssignmentView,
  before: number,
  after: number,
  csrfToken: string,
): Promise<{
  public_id: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  version: number;
  changed: boolean;
}> {
  return request(
    `/v1/admin/providers/${providerId}/service-assignments/${item.public_id}/buffers`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        expected_version: item.version,
        buffer_before_minutes: before,
        buffer_after_minutes: after,
      }),
      headers: { 'x-csrf-token': csrfToken },
    },
  );
}
export function previewAvailability(
  providerId: string,
  serviceId: string,
  startDate: string,
  endDate: string,
): Promise<{
  eligible: boolean;
  timezone: string;
  days: Array<{ local_date: string; windows: Array<Record<string, string>> }>;
}> {
  const q = new URLSearchParams({
    service_public_id: serviceId,
    start_date: startDate,
    end_date: endDate,
  });
  return request(`/v1/admin/providers/${providerId}/availability-preview?${q.toString()}`);
}

export function previewSchedulingSlots(
  providerId: string,
  serviceId: string,
  startDate: string,
  endDate: string,
  cursor?: string,
): Promise<{ data: SchedulingSlotsView; next_cursor: string | null }> {
  const q = new URLSearchParams({
    service_public_id: serviceId,
    start_date: startDate,
    end_date: endDate,
  });
  if (cursor) q.set('cursor', cursor);
  return requestWithMeta(`/v1/admin/providers/${providerId}/scheduling-slots?${q.toString()}`);
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
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; [key: string]: unknown };
    } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed', body?.error);
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function requestWithMeta<T>(path: string): Promise<{ data: T; next_cursor: string | null }> {
  const response = await fetch(`${baseUrl}${path}`, {
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'x-request-id': crypto.randomUUID(),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed');
  }
  const body = (await response.json()) as {
    data: T;
    meta: { next_cursor?: string | null };
  };
  return { data: body.data, next_cursor: body.meta.next_cursor ?? null };
}
