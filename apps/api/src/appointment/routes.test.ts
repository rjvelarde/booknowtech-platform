import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type RoleDocument, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('appointment routes', () => {
  it('does not grant appointment access to the provider role', async () => {
    const { app } = await testApp('provider');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/appointments',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
    await app.close();
  });

  it('uses a safe tenant-scoped 404 for an inaccessible appointment', async () => {
    const { app, store, context } = await testApp('tenant_owner');
    const lookup = vi.spyOn(store, 'getAppointment').mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/appointments/tenant-b-appointment',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('appointment_not_found');
    expect(lookup).toHaveBeenCalledWith(context.tenant!._id, 'tenant-b-appointment');
    await app.close();
  });
});

async function testApp(role: RoleDocument['role']) {
  const store = Object.create(AdminStore.prototype) as AdminStore;
  const context = contextFixture(role);
  vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
  const app = await buildApplication({
    environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
    readiness: new StubReadinessProbe(),
    adminStore: store,
    logger: false,
  });
  return { app, store, context };
}

function contextFixture(role: RoleDocument['role']): VerifiedAdminContext {
  const now = new Date();
  const userId = new ObjectId();
  const tenantId = new ObjectId();
  return {
    session: {
      _id: new ObjectId(),
      public_id: 'session',
      token_hash: 'hash',
      audience: 'admin',
      user_id: userId,
      selected_membership_id: new ObjectId(),
      csrf_token_hash: 'csrf',
      expires_at: new Date(Date.now() + 60_000),
      last_seen_at: now,
      created_at: now,
      rotated_at: now,
      revoked_at: null,
      revocation_reason: null,
      created_request_id: 'request',
    },
    user: {
      _id: userId,
      public_id: 'user',
      email_normalized: 'owner@example.test',
      display_name: 'Owner',
      password_hash: 'hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    membership: {
      _id: new ObjectId(),
      public_id: 'membership',
      tenant_id: tenantId,
      user_id: userId,
      role,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    tenant: {
      _id: tenantId,
      public_id: 'tenant-a',
      slug: 'tenant-a',
      display_name: 'Tenant A',
      legal_name: null,
      contact: { email_normalized: null, phone_e164: null, website_url: null },
      public_booking_enabled: false,
      appointment_email_settings: { enabled: false, sender_name: 'Tenant', reply_to_email: null },
      appointment_self_service: {
        enabled: false,
        cancellation_cutoff_minutes: 1440,
        reschedule_cutoff_minutes: 1440,
      },
      public_profile: {
        business_name: 'Tenant A',
        description: null,
        tagline: null,
        logo_url: null,
        primary_color: null,
        website_url: null,
        phone_e164: null,
        email_normalized: null,
      },
      booking_policy: { minimum_lead_minutes: 120, maximum_advance_days: 90 },
      public_booking_terms: {
        version: 'test-v1',
        acknowledgment_label: 'I agree to the booking terms.',
        terms_url: null,
      },
      default_timezone: 'UTC',
      default_slot_cadence_minutes: 15,
      locale: 'en-US',
      currency: 'USD',
      version: 1,
      updated_by: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    memberships: [],
  };
}

function authHeaders(): Record<string, string> {
  return { cookie: '__Host-bnt_admin_session=token', 'x-request-id': crypto.randomUUID() };
}
