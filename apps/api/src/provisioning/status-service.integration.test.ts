import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../database/migrate.js';
import type { ProvisioningAuthorization } from './guard.js';
import type { ValidatedProvisioningInput } from './input.js';
import { provisionTenant } from './service.js';
import { deactivateInternalQa, setTenantStatus } from './status-service.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('tenant status and internal-QA cleanup', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_status_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);

  beforeAll(async () => {
    await client.connect();
    activeDb = db;
    await migrateDatabase(db);
  });
  beforeEach(async () => {
    await Promise.all(
      [
        'tenants',
        'users',
        'roles',
        'tenant_provisioning_operations',
        'audit_logs',
        'appointments',
        'appointment_public_access_tokens',
        'admin_sessions',
        'notification_outbox',
      ].map((name) => db.collection(name).deleteMany({})),
    );
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('atomically suspends and restores only roles suspended by tenant status', async () => {
    const tenant = await provision();
    const stored = await db.collection('tenants').findOne({ public_id: tenant.tenant_public_id });
    const existingSuspended = new ObjectId();
    await db.collection('roles').insertOne(role(stored!._id, existingSuspended, 'suspended'));
    await seedAccess(stored!._id, existingSuspended);

    const suspended = await setTenantStatus({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      tenantSlug: input.slug,
      status: 'suspended',
    });
    expect(suspended).toMatchObject({
      outcome: 'completed',
      sessions_revoked: 1,
      tokens_revoked: 1,
    });
    expect(await db.collection('tenants').findOne({ _id: stored!._id })).toMatchObject({
      status: 'suspended',
      public_booking_enabled: false,
    });

    await setTenantStatus({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      tenantSlug: input.slug,
      status: 'active',
    });
    expect(await db.collection('tenants').findOne({ _id: stored!._id })).toMatchObject({
      status: 'active',
      public_booking_enabled: false,
    });
    const roles = await db.collection('roles').find({ tenant_id: stored!._id }).toArray();
    expect(roles.find(({ _id }) => _id.equals(existingSuspended))?.status).toBe('suspended');
    expect(roles.filter(({ status }) => status === 'active')).toHaveLength(1);
  });

  it('refuses cleanup until existing appointment lifecycle has terminalized active appointments', async () => {
    const tenant = await provision();
    const stored = await db.collection('tenants').findOne({ public_id: tenant.tenant_public_id });
    await db.collection('appointments').insertOne(appointment(stored!._id, 'scheduled'));
    const requestId = randomUUID();
    const refused = await deactivateInternalQa({
      client,
      database: db,
      authorization,
      requestId,
      tenantSlug: input.slug,
    });
    expect(refused).toMatchObject({
      outcome: 'refused',
      failure_category: 'active_appointments_remain',
      verification: { active_appointments: 1 },
    });
    expect(await db.collection('tenants').findOne({ _id: stored!._id })).toMatchObject({
      status: 'active',
    });
    expect(await db.collection('audit_logs').findOne({ request_id: requestId })).toMatchObject({
      event: 'internal_qa_cleanup_failed',
      outcome: 'failure',
    });
  });

  it('disables internal QA, revokes access, terminalizes only claimable outbox, and preserves evidence', async () => {
    const tenant = await provision();
    const stored = await db.collection('tenants').findOne({ public_id: tenant.tenant_public_id });
    const ownerRole = await db.collection('roles').findOne({ tenant_id: stored!._id });
    await seedAccess(stored!._id, ownerRole!._id);
    const completed = appointment(stored!._id, 'cancelled');
    await db.collection('appointments').insertOne(completed);
    const old = new Date(Date.now() - 600_000);
    await db
      .collection('notification_outbox')
      .insertMany([
        outbox(stored!._id, completed._id, 'pending', null),
        outbox(stored!._id, completed._id, 'processing', old),
        outbox(stored!._id, completed._id, 'delivered', null),
      ]);
    const requestId = randomUUID();
    const result = await deactivateInternalQa({
      client,
      database: db,
      authorization,
      requestId,
      tenantSlug: input.slug,
    });
    expect(result).toMatchObject({
      outcome: 'completed',
      outbox_failed: 2,
      verification: {
        active_appointments: 0,
        active_tokens: 0,
        active_sessions: 0,
        pending_or_processing_outbox: 0,
      },
    });
    expect(await db.collection('tenants').findOne({ _id: stored!._id })).toMatchObject({
      status: 'suspended',
      public_booking_enabled: false,
      appointment_email_settings: { enabled: false },
      appointment_self_service: { enabled: false },
    });
    expect(await db.collection('notification_outbox').countDocuments({ status: 'delivered' })).toBe(
      1,
    );
    expect(
      await db.collection('notification_outbox').countDocuments({
        status: 'failed',
        last_error_code: 'internal_qa_deactivated',
        processing_started_at: null,
      }),
    ).toBe(2);
    const reclaimed = await db.collection('notification_outbox').findOneAndUpdate(
      {
        $or: [
          { status: 'pending' },
          { status: 'processing', processing_started_at: { $lte: old } },
        ],
      },
      { $set: { status: 'processing' } },
    );
    expect(reclaimed).toBeNull();
    expect(await db.collection('appointments').countDocuments({ tenant_id: stored!._id })).toBe(1);
    expect(
      await db
        .collection('tenant_provisioning_operations')
        .countDocuments({ tenant_public_id: tenant.tenant_public_id }),
    ).toBe(2);
    expect(await db.collection('audit_logs').findOne({ request_id: requestId })).toMatchObject({
      event: 'internal_qa_cleanup_succeeded',
    });
  });

  it('replays one concurrent request and rejects a changed request fingerprint', async () => {
    const tenant = await provision();
    const requestId = randomUUID();
    const results = await Promise.all([
      setTenantStatus({
        client,
        database: db,
        authorization,
        requestId,
        tenantSlug: input.slug,
        status: 'suspended',
      }),
      setTenantStatus({
        client,
        database: db,
        authorization,
        requestId,
        tenantSlug: input.slug,
        status: 'suspended',
      }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['completed', 'replayed']);
    expect(
      await db
        .collection('tenant_provisioning_operations')
        .countDocuments({ request_id: requestId }),
    ).toBe(1);
    await expect(
      setTenantStatus({
        client,
        database: db,
        authorization,
        requestId,
        tenantSlug: input.slug,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'request_id_mismatch' });
    expect(tenant.tenant_public_id).toBeTruthy();
  });

  async function provision() {
    return provisionTenant({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      provisioningInput: input,
      passwordHash: 'scrypt$redacted',
    });
  }
});

const authorization = {
  operatorId: 'operator@example.test',
  reason: 'Approved Task 4 operation.',
  environment: { BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' },
} as ProvisioningAuthorization;
const input: ValidatedProvisioningInput = {
  business_name: 'Internal QA',
  legal_name: null,
  slug: 'internal-qa',
  timezone: 'America/New_York',
  currency: 'USD',
  designation: 'internal_qa',
  contact: { email: null, phone_e164: null, website_url: null },
  owner: { display_name: 'QA Owner', email: 'qa@example.test' },
  fallback_hostname: 'internal-qa.staging.booknowtech.com',
};

function role(tenantId: ObjectId, id: ObjectId, status: 'active' | 'suspended') {
  const now = new Date();
  return {
    _id: id,
    public_id: randomUUID(),
    tenant_id: tenantId,
    user_id: new ObjectId(),
    role: 'front_desk',
    status,
    created_at: now,
    updated_at: now,
  };
}
async function seedAccess(tenantId: ObjectId, roleId: ObjectId) {
  const now = new Date();
  await Promise.all([
    dbRef()
      .collection('admin_sessions')
      .insertOne({
        _id: new ObjectId(),
        public_id: randomUUID(),
        token_hash: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
        audience: 'admin',
        user_id: new ObjectId(),
        selected_membership_id: roleId,
        csrf_token_hash: 'a'.repeat(64),
        created_at: now,
        rotated_at: now,
        last_seen_at: now,
        expires_at: new Date(now.valueOf() + 86_400_000),
        revoked_at: null,
        revocation_reason: null,
        created_request_id: randomUUID(),
      }),
    dbRef().collection('appointment_public_access_tokens').insertOne(token(tenantId)),
  ]);
}
let activeDb: ReturnType<MongoClient['db']>;
function dbRef() {
  return activeDb;
}
function token(tenantId: ObjectId) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    public_id: randomUUID(),
    tenant_id: tenantId,
    tenant_public_id: randomUUID(),
    appointment_id: new ObjectId(),
    appointment_public_id: randomUUID(),
    purpose: 'appointment_manage',
    generation: 1,
    token_hash: 'b'.repeat(64),
    status: 'active',
    issued_at: now,
    expires_at: new Date(now.valueOf() + 86_400_000),
    consumed_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
    purge_at: new Date(now.valueOf() + 172_800_000),
    mutation: null,
  };
}
function appointment(tenantId: ObjectId, status: 'scheduled' | 'cancelled') {
  const now = new Date();
  return {
    _id: new ObjectId(),
    public_id: randomUUID(),
    reference: `BNT-${randomUUID().slice(0, 8)}`,
    tenant_id: tenantId,
    customer_id: new ObjectId(),
    provider_id: new ObjectId(),
    service_id: new ObjectId(),
    provider_service_assignment_id: new ObjectId(),
    starts_at: new Date(now.valueOf() + 86_400_000),
    ends_at: new Date(now.valueOf() + 90_000_000),
    blocked_starts_at: new Date(now.valueOf() + 86_400_000),
    blocked_ends_at: new Date(now.valueOf() + 90_000_000),
    timezone: 'America/New_York',
    local_start_date: '2026-08-13',
    snapshot: {
      customer_display_name: 'QA',
      provider_display_name: 'QA',
      service_name: 'QA',
      service_duration_minutes: 60,
      slot_cadence_minutes: 15,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      delivery_mode: 'virtual',
      base_price_minor: 0,
      booking_fee_minor: 0,
      currency: 'USD',
      customer_note: null,
    },
    location: { mode: 'virtual', customer_address: null },
    status,
    source: 'business_hub',
    public_submission: null,
    booking_terms: null,
    cancelled_at: status === 'cancelled' ? now : null,
    cancelled_by: null,
    cancellation_reason: status === 'cancelled' ? 'other' : null,
    cancellation_detail: null,
    completed_at: null,
    completed_by: null,
    no_show_at: null,
    no_show_by: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: null,
    updated_by: null,
  };
}
function outbox(
  tenantId: ObjectId,
  appointmentId: ObjectId,
  status: 'pending' | 'processing' | 'delivered',
  processing: Date | null,
) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    public_id: randomUUID(),
    tenant_id: tenantId,
    appointment_id: appointmentId,
    appointment_public_id: randomUUID(),
    appointment_reference: 'BNT-QA',
    type: 'appointment_confirmation',
    channel: 'email',
    recipient: 'qa@example.test',
    template_data: {
      business_name: 'QA',
      business_logo_url: null,
      business_phone: null,
      business_email: null,
      business_website: null,
      customer_name: 'QA',
      provider_name: 'QA',
      provider_photo_url: null,
      service_name: 'QA',
      starts_at: now,
      ends_at: now,
      timezone: 'America/New_York',
      location_mode: 'virtual',
    },
    appointment_access: null,
    status,
    attempt_count: 0,
    next_attempt_at: now,
    processing_started_at: processing,
    delivered_at: status === 'delivered' ? now : null,
    failed_at: null,
    provider_message_id: status === 'delivered' ? 'message' : null,
    last_error_code: null,
    request_id: randomUUID(),
    created_at: now,
    updated_at: now,
  };
}
