import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantProvisioningOperationDocument } from '../admin/store.js';
import { migrateDatabase } from './migrate.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('administrative foundation migration', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_test_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);

  beforeAll(async () => client.connect());
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('is repeatable and creates the required session indexes', async () => {
    await migrateDatabase(db);
    await migrateDatabase(db);

    const indexes = await db.collection('admin_sessions').indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'admin_sessions_public_id_unique',
        'admin_sessions_token_hash_unique',
        'admin_sessions_expiry_ttl',
        'admin_sessions_user_revocation',
        'admin_sessions_membership_revocation',
      ]),
    );
    expect(indexes.find(({ name }) => name === 'admin_sessions_expiry_ttl')).toMatchObject({
      expireAfterSeconds: 0,
    });
  });

  it('creates strict, additive service-heartbeat storage and named indexes', async () => {
    await migrateDatabase(db);
    await migrateDatabase(db);

    const indexes = await db.collection('service_heartbeats').indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'service_heartbeats_instance_unique',
        'service_heartbeats_freshness',
        'service_heartbeats_expiry_ttl',
      ]),
    );
    expect(indexes.find(({ name }) => name === 'service_heartbeats_instance_unique')).toMatchObject(
      {
        key: { service: 1, environment: 1, instance_id: 1 },
        unique: true,
      },
    );
    expect(indexes.find(({ name }) => name === 'service_heartbeats_freshness')).toMatchObject({
      key: { service: 1, environment: 1, observed_at: -1 },
    });
    expect(indexes.find(({ name }) => name === 'service_heartbeats_expiry_ttl')).toMatchObject({
      key: { expires_at: 1 },
      expireAfterSeconds: 0,
    });

    const validHeartbeat = {
      service: 'worker',
      environment: 'staging',
      commit_sha: 'a'.repeat(40),
      instance_id: randomUUID(),
      observed_at: new Date(),
      expires_at: new Date(Date.now() + 600_000),
    };
    await db.collection('service_heartbeats').insertOne(validHeartbeat);
    await expect(
      db.collection('service_heartbeats').insertOne({
        ...validHeartbeat,
        _id: new ObjectId(),
      }),
    ).rejects.toThrow();

    await expect(
      db.collection('service_heartbeats').insertOne({
        ...validHeartbeat,
        _id: new ObjectId(),
        instance_id: randomUUID(),
        recipient: 'customer@example.test',
      }),
    ).rejects.toThrow();
    await expect(
      db.collection('service_heartbeats').insertOne({
        ...validHeartbeat,
        _id: new ObjectId(),
        instance_id: randomUUID(),
        commit_sha: 'not-an-immutable-sha',
      }),
    ).rejects.toThrow();
  });

  it('backfills legacy tenant and user records without changing existing values', async () => {
    const legacyDb = client.db(`booknowtech_legacy_${randomUUID().replaceAll('-', '')}`);
    await legacyDb.createCollection('tenants');
    await legacyDb.createCollection('users');
    const now = new Date();
    const tenantId = new ObjectId();
    const userId = new ObjectId();
    await legacyDb.collection('tenants').insertOne({
      _id: tenantId,
      public_id: randomUUID(),
      slug: 'legacy-tenant',
      display_name: 'Legacy Tenant',
      legal_name: null,
      contact: { email_normalized: null, phone_e164: null, website_url: null },
      default_timezone: 'America/New_York',
      default_slot_cadence_minutes: 30,
      locale: 'en-US',
      currency: 'USD',
      public_booking_enabled: true,
      public_profile: {
        business_name: 'Legacy Tenant',
        description: null,
        tagline: null,
        logo_url: null,
        primary_color: null,
        website_url: null,
        phone_e164: null,
        email_normalized: null,
      },
      booking_policy: { minimum_lead_minutes: 60, maximum_advance_days: 45 },
      public_booking_terms: {
        version: 'legacy-v1',
        acknowledgment_label: 'Legacy terms',
        terms_url: null,
      },
      appointment_email_settings: {
        enabled: true,
        sender_name: 'Legacy Tenant',
        reply_to_email: null,
      },
      appointment_self_service: {
        enabled: true,
        cancellation_cutoff_minutes: 720,
        reschedule_cutoff_minutes: 720,
      },
      version: 4,
      updated_by: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    await legacyDb.collection('users').insertOne({
      _id: userId,
      public_id: randomUUID(),
      email_normalized: 'legacy@example.test',
      display_name: 'Legacy Owner',
      password_hash: 'legacy-hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    });

    await migrateDatabase(legacyDb);
    await migrateDatabase(legacyDb);

    expect(await legacyDb.collection('tenants').findOne({ _id: tenantId })).toMatchObject({
      designation: 'customer',
      public_booking_enabled: true,
      default_slot_cadence_minutes: 30,
      booking_policy: { minimum_lead_minutes: 60, maximum_advance_days: 45 },
    });
    expect(await legacyDb.collection('users').findOne({ _id: userId })).toMatchObject({
      must_change_password: false,
      status: 'active',
    });
    await legacyDb.dropDatabase();
  });

  it('creates strict provisioning-operation storage and named indexes', async () => {
    await migrateDatabase(db);
    const collection = db.collection('tenant_provisioning_operations');
    const indexes = await collection.indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'tenant_provisioning_operations_public_id_unique',
        'tenant_provisioning_operations_request_id_unique',
        'tenant_provisioning_operations_request_fingerprint',
        'tenant_provisioning_operations_tenant_created',
        'tenant_provisioning_operations_status_created',
      ]),
    );

    const operation: TenantProvisioningOperationDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      request_id: randomUUID(),
      operation_type: 'create_tenant',
      request_fingerprint: 'a'.repeat(64),
      operator_id: 'operator@example.test',
      reason: 'Provision an approved design-partner tenant.',
      tenant_public_id: null,
      owner_user_public_id: null,
      designation: 'customer',
      status: 'started',
      failure_category: null,
      created_at: new Date(),
      completed_at: null,
    };
    await expect(collection.insertOne(operation)).resolves.toBeDefined();
    await expect(
      collection.insertOne({ ...operation, _id: new ObjectId(), public_id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      collection.insertOne({
        ...operation,
        _id: new ObjectId(),
        public_id: randomUUID(),
        request_id: randomUUID(),
        raw_owner_email: 'owner@example.test',
      }),
    ).rejects.toThrow();
    await expect(
      collection.insertOne({
        ...operation,
        _id: new ObjectId(),
        public_id: randomUUID(),
        request_id: randomUUID(),
        designation: 'demo',
      }),
    ).rejects.toThrow();
  });

  it('requires the additive tenant designation and user password-change flag', async () => {
    await migrateDatabase(db);
    await expect(
      db.collection('tenants').insertOne({
        public_id: randomUUID(),
        slug: 'missing-designation',
        display_name: 'Missing Designation',
        legal_name: null,
        contact: { email_normalized: null, phone_e164: null, website_url: null },
        default_timezone: 'UTC',
        default_slot_cadence_minutes: 15,
        locale: 'en-US',
        currency: 'USD',
        public_booking_enabled: false,
        public_profile: {
          business_name: 'Missing Designation',
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
          version: '1',
          acknowledgment_label: 'I agree to the booking and cancellation terms.',
          terms_url: null,
        },
        appointment_email_settings: {
          enabled: false,
          sender_name: 'Missing Designation',
          reply_to_email: null,
        },
        appointment_self_service: {
          enabled: false,
          cancellation_cutoff_minutes: 1_440,
          reschedule_cutoff_minutes: 1_440,
        },
        version: 1,
        updated_by: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      db.collection('users').insertOne({
        public_id: randomUUID(),
        email_normalized: 'missing-flag@example.test',
        display_name: 'Missing Flag',
        password_hash: 'hash',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('rejects roles outside the fixed role model', async () => {
    await expect(
      db.collection('roles').insertOne({
        public_id: randomUUID(),
        tenant_id: new ObjectId(),
        user_id: new ObjectId(),
        role: 'custom_role',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('creates strict shared rate-limit storage and named indexes', async () => {
    await migrateDatabase(db);
    const indexes = await db.collection('request_rate_limits').indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'request_rate_limits_bucket_unique',
        'request_rate_limits_expiry_ttl',
      ]),
    );
    expect(indexes.find(({ name }) => name === 'request_rate_limits_expiry_ttl')).toMatchObject({
      expireAfterSeconds: 0,
    });
    await expect(
      db.collection('request_rate_limits').insertOne({
        scope: 'public_discovery',
        tenant_key: 'platform',
        subject_hash: 'a'.repeat(64),
        bucket_started_at: new Date(),
        count: 1,
        expires_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        raw_ip: '203.0.113.8',
      }),
    ).rejects.toThrow();
  });

  it('creates tenant-scoped catalog indexes and rejects invalid delivery modes', async () => {
    await migrateDatabase(db);
    const indexes = await db.collection('services').indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'services_tenant_public_id_unique',
        'services_tenant_internal_code_unique',
        'services_catalog_list',
        'services_public_catalog',
      ]),
    );
    const service = {
      public_id: randomUUID(),
      tenant_id: new ObjectId(),
      internal_code: 'INVALID',
      name: 'Invalid',
      description: null,
      delivery_mode: 'physical',
      duration_minutes: 30,
      base_price_minor: 1000,
      booking_fee_minor: 100,
      slot_cadence_minutes: null,
      currency: 'USD',
      status: 'active',
      version: 1,
      created_by: new ObjectId(),
      updated_by: new ObjectId(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    await expect(db.collection('services').insertOne(service)).rejects.toThrow();
    await expect(
      db.collection('services').insertOne({
        ...service,
        public_id: randomUUID(),
        internal_code: 'INVALID-CADENCE',
        delivery_mode: 'provider_location',
        slot_cadence_minutes: 7,
      }),
    ).rejects.toThrow();
  });

  it('creates tenant-scoped provider and assignment indexes', async () => {
    await migrateDatabase(db);
    expect((await db.collection('providers').indexes()).map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'providers_tenant_public_id_unique',
        'providers_tenant_internal_code_unique',
        'providers_directory_list',
        'providers_public_directory',
      ]),
    );
    expect(
      (await db.collection('provider_service_assignments').indexes()).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        'provider_service_tenant_provider_service_unique',
        'provider_service_tenant_public_id_unique',
        'provider_service_by_provider',
        'provider_service_by_service',
      ]),
    );
  });

  it('enforces provider code uniqueness within a tenant and permits cross-tenant reuse', async () => {
    await migrateDatabase(db);
    const actor = new ObjectId();
    const tenantA = new ObjectId();
    const tenantB = new ObjectId();
    const provider = (tenantId: ObjectId) => ({
      public_id: randomUUID(),
      tenant_id: tenantId,
      internal_code: 'LISA',
      display_name: 'Lisa',
      first_name: 'Lisa',
      last_name: null,
      email_normalized: null,
      phone_e164: null,
      photo_url: null,
      bio: null,
      status: 'active',
      customer_selectable: true,
      accepting_new_clients: true,
      display_order: 10,
      linked_user_id: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: actor,
      updated_by: actor,
    });
    await db.collection('providers').insertOne(provider(tenantA));
    await expect(db.collection('providers').insertOne(provider(tenantA))).rejects.toThrow();
    await expect(db.collection('providers').insertOne(provider(tenantB))).resolves.toBeDefined();
  });

  it('enforces one persistent assignment per tenant, provider, and service', async () => {
    await migrateDatabase(db);
    const actor = new ObjectId();
    const tenantId = new ObjectId();
    const providerId = new ObjectId();
    const serviceId = new ObjectId();
    const assignment = () => ({
      public_id: randomUUID(),
      tenant_id: tenantId,
      provider_id: providerId,
      service_id: serviceId,
      status: 'active',
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: actor,
      updated_by: actor,
    });
    await db.collection('provider_service_assignments').insertOne(assignment());
    await expect(
      db.collection('provider_service_assignments').insertOne(assignment()),
    ).rejects.toThrow();
  });

  it('creates customer search indexes and permits the same contact in separate tenants', async () => {
    await migrateDatabase(db);
    expect((await db.collection('customers').indexes()).map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'customers_tenant_public_id_unique',
        'customers_directory',
        'customers_email_lookup',
        'customers_phone_lookup',
        'customers_first_name_search',
        'customers_full_name_search',
        'customers_updated',
      ]),
    );
    const actor = new ObjectId();
    const customer = (tenantId: ObjectId) => ({
      public_id: randomUUID(),
      tenant_id: tenantId,
      first_name: 'Maya',
      last_name: 'Johnson',
      preferred_name: null,
      first_name_normalized: 'maya',
      last_name_normalized: 'johnson',
      full_name_normalized: 'maya johnson',
      email_normalized: 'maya@example.test',
      mobile_phone_e164: '+14045550101',
      mobile_phone_digits: '14045550101',
      addresses: [],
      communication_preferences: {
        preferred_channel: 'email',
        marketing_email: 'unknown',
        marketing_sms: 'unknown',
      },
      source: 'manual',
      external_references: [],
      status: 'active',
      deactivated_at: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: actor,
      updated_by: actor,
    });
    await db.collection('customers').insertOne(customer(new ObjectId()));
    await expect(
      db.collection('customers').insertOne(customer(new ObjectId())),
    ).resolves.toBeDefined();
    await expect(
      db.collection('customers').insertOne({ ...customer(new ObjectId()), source: 'unknown' }),
    ).rejects.toThrow();
  });

  it('creates appointment reference, agenda, conflict, and schedule-lock indexes', async () => {
    await migrateDatabase(db);
    expect((await db.collection('appointments').indexes()).map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'appointments_tenant_public_id_unique',
        'appointments_tenant_reference_unique',
        'appointments_provider_conflicts',
        'appointments_tenant_upcoming',
        'appointments_tenant_customer_agenda',
      ]),
    );
    expect(
      (await db.collection('appointment_schedule_locks').indexes()).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        'appointment_schedule_locks_scope_unique',
        'appointment_schedule_locks_updated',
      ]),
    );
  });

  it('creates public appointment access token uniqueness, lookup, and TTL indexes', async () => {
    expect(
      (await db.collection('appointment_public_access_tokens').indexes()).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        'appointment_access_public_id_unique',
        'appointment_access_token_hash_unique',
        'appointment_access_lookup',
        'appointment_access_one_active',
        'appointment_access_purge_ttl',
      ]),
    );
  });

  it('rolls back token and outbox issuance together when the transaction fails', async () => {
    const session = client.startSession();
    const tokenId = randomUUID();
    const noticeId = randomUUID();
    const now = new Date();
    await expect(
      session.withTransaction(async () => {
        await db.collection('appointment_public_access_tokens').insertOne(
          {
            public_id: tokenId,
            tenant_id: new ObjectId(),
            tenant_public_id: randomUUID(),
            appointment_id: new ObjectId(),
            appointment_public_id: randomUUID(),
            purpose: 'appointment_manage',
            generation: 1,
            token_hash: 'a'.repeat(64),
            status: 'active',
            issued_at: now,
            expires_at: new Date(now.valueOf() + 86_400_000),
            consumed_at: null,
            revoked_at: null,
            created_at: now,
            updated_at: now,
            purge_at: new Date(now.valueOf() + 100 * 86_400_000),
            mutation: null,
          },
          { session },
        );
        await db.collection('notification_outbox').insertOne(
          {
            public_id: noticeId,
            tenant_id: new ObjectId(),
            appointment_id: new ObjectId(),
            appointment_public_id: randomUUID(),
            appointment_reference: 'BNT-1234ABCD',
            type: 'appointment_confirmation',
            channel: 'email',
            recipient: 'customer@example.test',
            template_data: {
              business_name: 'Business',
              business_logo_url: null,
              business_phone: null,
              business_email: null,
              business_website: null,
              customer_name: 'Customer',
              provider_name: 'Provider',
              provider_photo_url: null,
              service_name: 'Service',
              starts_at: now,
              ends_at: new Date(now.valueOf() + 3_600_000),
              timezone: 'UTC',
              location_mode: 'provider_location',
            },
            appointment_access: { token_public_id: tokenId, generation: 1 },
            status: 'pending',
            attempt_count: 0,
            next_attempt_at: now,
            processing_started_at: null,
            delivered_at: null,
            failed_at: null,
            provider_message_id: null,
            last_error_code: null,
            request_id: randomUUID(),
            created_at: now,
            updated_at: now,
          },
          { session },
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    await session.endSession();
    expect(
      await db
        .collection('appointment_public_access_tokens')
        .countDocuments({ public_id: tokenId }),
    ).toBe(0);
    expect(await db.collection('notification_outbox').countDocuments({ public_id: noticeId })).toBe(
      0,
    );
  });

  it('enforces one active management token per appointment under concurrent issuance', async () => {
    const tenantId = new ObjectId();
    const appointmentId = new ObjectId();
    const now = new Date();
    const token = (suffix: string) => ({
      public_id: randomUUID(),
      tenant_id: tenantId,
      tenant_public_id: randomUUID(),
      appointment_id: appointmentId,
      appointment_public_id: randomUUID(),
      purpose: 'appointment_manage',
      generation: 1,
      token_hash: suffix.repeat(64),
      status: 'active',
      issued_at: now,
      expires_at: new Date(now.valueOf() + 86_400_000),
      consumed_at: null,
      revoked_at: null,
      created_at: now,
      updated_at: now,
      purge_at: new Date(now.valueOf() + 100 * 86_400_000),
      mutation: null,
    });
    const results = await Promise.allSettled([
      db.collection('appointment_public_access_tokens').insertOne(token('b')),
      db.collection('appointment_public_access_tokens').insertOne(token('c')),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });

  it('permits authenticated staff to update an appointment created through public booking', async () => {
    await migrateDatabase(db);

    const now = new Date();
    const appointmentId = new ObjectId();

    await db.collection('appointments').insertOne({
      _id: appointmentId,
      public_id: randomUUID(),
      reference: `BNT-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      tenant_id: new ObjectId(),
      customer_id: new ObjectId(),
      provider_id: new ObjectId(),
      service_id: new ObjectId(),
      provider_service_assignment_id: new ObjectId(),
      starts_at: new Date('2026-08-20T14:00:00.000Z'),
      ends_at: new Date('2026-08-20T14:30:00.000Z'),
      blocked_starts_at: new Date('2026-08-20T14:00:00.000Z'),
      blocked_ends_at: new Date('2026-08-20T14:30:00.000Z'),
      timezone: 'America/New_York',
      local_start_date: '2026-08-20',
      snapshot: {
        customer_display_name: 'Public Customer',
        provider_display_name: 'Lisa',
        service_name: 'Brazilian Wax',
        service_duration_minutes: 30,
        slot_cadence_minutes: 15,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        delivery_mode: 'provider_location',
        base_price_minor: 5500,
        booking_fee_minor: 125,
        currency: 'USD',
        customer_note: null,
      },
      location: { mode: 'provider_location', customer_address: null },
      status: 'scheduled',
      source: 'public_booking',
      public_submission: {
        idempotency_key_hash: 'a'.repeat(64),
        request_fingerprint: 'b'.repeat(64),
      },
      booking_terms: { version: 'staging-v1', accepted_at: now },
      cancelled_at: null,
      cancelled_by: null,
      cancellation_reason: null,
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
    });

    const staffUserId = new ObjectId();
    await expect(
      db.collection('appointments').updateOne(
        { _id: appointmentId, version: 1 },
        {
          $set: { updated_by: staffUserId, updated_at: new Date() },
          $inc: { version: 1 },
        },
      ),
    ).resolves.toMatchObject({ modifiedCount: 1 });

    const updatedAppointment = await db.collection('appointments').findOne({
      _id: appointmentId,
    });
    expect(updatedAppointment).toMatchObject({
      source: 'public_booking',
      created_by: null,
      version: 2,
    });
    expect(updatedAppointment?.updated_by).toEqual(staffUserId);
  });
});
