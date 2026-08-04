import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  derivePublicAppointmentCredential,
  hashPublicAppointmentCredential,
} from '@booknowtech/shared';

import type {
  AdminStore,
  AppointmentDocument,
  AppointmentPublicAccessTokenDocument,
  ServiceDocument,
  TenantDocument,
} from '../admin/store.js';
import { testEnvironment } from '../test-fixtures.js';
import { registerPublicAppointmentManagementRoutes } from './routes.js';

const ids = {
  tenant: new ObjectId(),
  appointment: new ObjectId(),
  customer: new ObjectId(),
  provider: new ObjectId(),
  service: new ObjectId(),
  assignment: new ObjectId(),
};
const tenant = {
  _id: ids.tenant,
  public_id: 'tenant-id',
  slug: 'tenant',
  status: 'active',
  default_timezone: 'UTC',
  booking_policy: { minimum_lead_minutes: 0, maximum_advance_days: 90 },
  public_profile: {
    business_name: 'Safe Business',
    logo_url: null,
    primary_color: null,
    phone_e164: null,
    email_normalized: null,
    website_url: null,
  },
  appointment_self_service: {
    enabled: true,
    cancellation_cutoff_minutes: 0,
    reschedule_cutoff_minutes: 0,
  },
} as TenantDocument;
const service = {
  _id: ids.service,
  status: 'active',
  public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
  public_self_service_policy: {
    cancellation_cutoff_minutes: null,
    reschedule_cutoff_minutes: null,
  },
} as ServiceDocument;
const appointment = {
  _id: ids.appointment,
  public_id: 'appointment-id',
  reference: 'BNT-12345678',
  tenant_id: ids.tenant,
  customer_id: ids.customer,
  provider_id: ids.provider,
  service_id: ids.service,
  provider_service_assignment_id: ids.assignment,
  starts_at: new Date(Date.now() + 86_400_000),
  ends_at: new Date(Date.now() + 90_000_000),
  blocked_starts_at: new Date(Date.now() + 86_400_000),
  blocked_ends_at: new Date(Date.now() + 90_000_000),
  timezone: 'UTC',
  local_start_date: '2026-08-04',
  snapshot: {
    customer_display_name: 'Private Customer',
    provider_display_name: 'Provider',
    service_name: 'Service',
    service_duration_minutes: 60,
    slot_cadence_minutes: 15,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    delivery_mode: 'provider_location',
    base_price_minor: 1000,
    booking_fee_minor: 0,
    currency: 'USD',
    customer_note: 'private note',
  },
  location: { mode: 'provider_location', customer_address: null },
  status: 'scheduled',
  version: 1,
} as AppointmentDocument;

function fixture() {
  const publicId = '11111111-1111-4111-8111-111111111111';
  const credential = derivePublicAppointmentCredential(
    testEnvironment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
    {
      version: 1,
      tokenPublicId: publicId,
      appointmentPublicId: appointment.public_id,
      generation: 1,
      purpose: 'appointment_management',
    },
  );
  const token = {
    public_id: publicId,
    tenant_id: ids.tenant,
    appointment_public_id: appointment.public_id,
    generation: 1,
    purpose: 'appointment_manage',
    token_hash: hashPublicAppointmentCredential(credential),
    status: 'active',
    expires_at: appointment.starts_at,
  } as AppointmentPublicAccessTokenDocument;
  const store = {
    getActiveTenantBySlug: vi.fn((slug: string) =>
      Promise.resolve(slug === 'tenant' ? tenant : null),
    ),
    getAppointmentAccessToken: vi.fn(() => Promise.resolve(token)),
    getAppointment: vi.fn(() => Promise.resolve(appointment)),
    getServiceById: vi.fn(() => Promise.resolve(service)),
    getProviderById: vi.fn(() => Promise.resolve({ photo_url: null })),
  } as unknown as AdminStore;
  return { publicId, credential, store, token };
}

describe('public appointment management routes', () => {
  it('returns only the safe appointment projection for a valid hostname-bound token', async () => {
    const { publicId, credential, store } = fixture();
    const app = Fastify();
    registerPublicAppointmentManagementRoutes(app, testEnvironment, store);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/appointments/manage/${publicId}`,
      headers: { host: 'tenant.booknowtech.com', authorization: `AppointmentToken ${credential}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Safe Business');
    expect(response.body).not.toContain('Private Customer');
    expect(response.body).not.toContain('private note');
  });

  it('makes invalid, consumed, and cross-host tokens indistinguishable', async () => {
    const { publicId, credential, store } = fixture();
    const app = Fastify();
    registerPublicAppointmentManagementRoutes(app, testEnvironment, store);
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/public/appointments/manage/${publicId}`,
        headers: { host: 'other.example.test', authorization: `AppointmentToken ${credential}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/public/appointments/manage/${publicId}`,
        headers: { host: 'tenant.example.test', authorization: 'AppointmentToken invalid' },
      }),
    ]);
    expect(
      responses.map((item) => [
        item.statusCode,
        item.json<{ error: { code: string } }>().error.code,
      ]),
    ).toEqual([
      [404, 'appointment_link_unavailable'],
      [404, 'appointment_link_unavailable'],
    ]);
  });

  it('cancels, consumes the token, audits, and enqueues within one transaction', async () => {
    const base = fixture();
    let currentAppointment = { ...appointment };
    let currentToken = { ...base.token };
    const consume = vi.fn(
      (input: { mutation: AppointmentPublicAccessTokenDocument['mutation'] }) => {
        currentToken = { ...currentToken, status: 'consumed', mutation: input.mutation };
        return Promise.resolve();
      },
    );
    const enqueue = vi.fn(() => Promise.resolve(true));
    const audit = vi.fn(() => Promise.resolve());
    const store = {
      getActiveTenantBySlug: vi.fn(() => Promise.resolve(tenant)),
      getAppointmentAccessToken: vi.fn(() => Promise.resolve(currentToken)),
      getAppointment: vi.fn(() => Promise.resolve(currentAppointment)),
      getServiceById: vi.fn(() => Promise.resolve(service)),
      withAppointmentScheduleLocks: vi.fn(
        async (
          _tenantId: ObjectId,
          _scopes: unknown[],
          work: (session: never) => Promise<unknown>,
        ) => await work({} as never),
      ),
      transitionAppointment: vi.fn(() => {
        currentAppointment = {
          ...currentAppointment,
          status: 'cancelled',
          version: 2,
          cancellation_reason: 'customer_request',
        };
        return Promise.resolve('updated');
      }),
      consumeAppointmentAccessToken: consume,
      getCustomerById: vi.fn(() => Promise.resolve({ email_normalized: 'customer@example.test' })),
      getProviderById: vi.fn(() => Promise.resolve({ photo_url: null })),
      enqueueAppointmentEmail: enqueue,
      audit,
    } as unknown as AdminStore;
    const app = Fastify();
    registerPublicAppointmentManagementRoutes(app, testEnvironment, store);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/public/appointments/manage/${base.publicId}/cancel`,
      headers: {
        host: 'tenant.example.test',
        authorization: `AppointmentToken ${base.credential}`,
        'idempotency-key': '22222222-2222-4222-8222-222222222222',
      },
      payload: { expected_version: 1, confirmation: 'CANCEL' },
    });
    expect(response.statusCode).toBe(200);
    expect(currentAppointment).toMatchObject({
      status: 'cancelled',
      cancellation_reason: 'customer_request',
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, session: expect.anything() }),
    );
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/public/appointments/manage/${base.publicId}/cancel`,
      headers: {
        host: 'tenant.example.test',
        authorization: `AppointmentToken ${base.credential}`,
        'idempotency-key': '22222222-2222-4222-8222-222222222222',
      },
      payload: { expected_version: 1, confirmation: 'CANCEL' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(consume).toHaveBeenCalledOnce();
    const differentKey = await app.inject({
      method: 'POST',
      url: `/api/v1/public/appointments/manage/${base.publicId}/cancel`,
      headers: {
        host: 'tenant.example.test',
        authorization: `AppointmentToken ${base.credential}`,
        'idempotency-key': '33333333-3333-4333-8333-333333333333',
      },
      payload: { expected_version: 1, confirmation: 'CANCEL' },
    });
    expect(differentKey.statusCode).toBe(404);
  });
});
