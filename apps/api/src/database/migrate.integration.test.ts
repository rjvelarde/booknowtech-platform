import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

  it('creates tenant-scoped catalog indexes and rejects invalid delivery modes', async () => {
    await migrateDatabase(db);
    const indexes = await db.collection('services').indexes();
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'services_tenant_public_id_unique',
        'services_tenant_internal_code_unique',
        'services_catalog_list',
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
});
