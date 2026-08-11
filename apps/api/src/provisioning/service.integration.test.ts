import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../database/migrate.js';
import type { ProvisioningAuthorization } from './guard.js';
import type { ValidatedProvisioningInput } from './input.js';
import { provisionTenant } from './service.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('tenant provisioning transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_provisioning_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
  });
  beforeEach(async () =>
    Promise.all(
      ['tenants', 'users', 'roles', 'tenant_provisioning_operations', 'audit_logs'].map((name) =>
        db.collection(name).deleteMany({}),
      ),
    ),
  );
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('atomically creates only tenant, owner, owner role, operation, and audit evidence', async () => {
    const requestId = randomUUID();
    const result = await create(requestId, tenantInput());
    expect(result.outcome).toBe('created');
    expect(await counts()).toEqual({
      tenants: 1,
      users: 1,
      roles: 1,
      operations: 1,
      audits: 1,
      services: 0,
      appointments: 0,
    });
    expect(
      await db.collection('tenants').findOne({ public_id: result.tenant_public_id }),
    ).toMatchObject({
      public_booking_enabled: false,
      designation: 'internal_qa',
      appointment_email_settings: { enabled: false },
      appointment_self_service: { enabled: false },
    });
    expect(
      await db.collection('users').findOne({ public_id: result.owner_user_public_id }),
    ).toMatchObject({ must_change_password: true, password_hash: 'scrypt$redacted-hash' });
    expect(
      JSON.stringify(
        await db.collection('tenant_provisioning_operations').findOne({ request_id: requestId }),
      ),
    ).not.toContain('Temporary-Password');
    expect(
      JSON.stringify(await db.collection('audit_logs').findOne({ request_id: requestId })),
    ).not.toContain('Temporary-Password');
  });

  it('returns the committed result on replay, including after a dropped post-commit response', async () => {
    const requestId = randomUUID();
    await expect(
      create(requestId, tenantInput(), {
        afterCommit: () => {
          throw new Error('simulated SSH drop');
        },
      }),
    ).rejects.toThrow('simulated SSH drop');
    const replay = await create(requestId, tenantInput());
    expect(replay.outcome).toBe('replayed');
    expect(await counts()).toMatchObject({
      tenants: 1,
      users: 1,
      roles: 1,
      operations: 1,
      audits: 1,
    });
  });

  it('rejects request-ID fingerprint mismatches and safe duplicate identities', async () => {
    const requestId = randomUUID();
    await create(requestId, tenantInput());
    await expect(
      create(requestId, tenantInput({ business_name: 'Different' })),
    ).rejects.toMatchObject({ code: 'request_id_mismatch' });
    await expect(
      create(
        randomUUID(),
        tenantInput({ owner: { display_name: 'Other', email: 'other@example.test' } }),
      ),
    ).rejects.toMatchObject({ code: 'tenant_slug_conflict' });
    await expect(
      create(
        randomUUID(),
        tenantInput({
          slug: 'another-qa',
          fallback_hostname: 'another-qa.staging.booknowtech.com',
        }),
      ),
    ).rejects.toMatchObject({ code: 'owner_email_conflict' });
  });

  it.each(['tenant', 'owner', 'role', 'operation', 'audit'])(
    'rolls back every document when interrupted after %s',
    async (stage) => {
      await expect(
        create(randomUUID(), tenantInput(), {
          beforeCommit: (current) => {
            if (current === stage) throw new Error('interrupted');
          },
        }),
      ).rejects.toThrow('interrupted');
      expect(await counts()).toMatchObject({
        tenants: 0,
        users: 0,
        roles: 0,
        operations: 0,
        audits: 0,
      });
    },
  );

  it('allows only one commit for concurrent identical requests', async () => {
    const requestId = randomUUID();
    const results = await Promise.all([
      create(requestId, tenantInput()),
      create(requestId, tenantInput()),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['created', 'replayed']);
    expect(await counts()).toMatchObject({
      tenants: 1,
      users: 1,
      roles: 1,
      operations: 1,
      audits: 1,
    });
  });

  async function create(
    requestId: string,
    provisioningInput: ValidatedProvisioningInput,
    hooks?: Parameters<typeof provisionTenant>[0]['hooks'],
  ) {
    return provisionTenant({
      client,
      database: db,
      authorization,
      requestId,
      provisioningInput,
      passwordHash: 'scrypt$redacted-hash',
      ...(hooks ? { hooks } : {}),
    });
  }
  async function counts() {
    return {
      tenants: await db.collection('tenants').countDocuments(),
      users: await db.collection('users').countDocuments(),
      roles: await db.collection('roles').countDocuments(),
      operations: await db.collection('tenant_provisioning_operations').countDocuments(),
      audits: await db.collection('audit_logs').countDocuments(),
      services: await db.collection('services').countDocuments(),
      appointments: await db.collection('appointments').countDocuments(),
    };
  }
});

const authorization = {
  operatorId: 'operator@example.test',
  reason: 'Provision approved internal QA tenant.',
  environment: { BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' },
} as ProvisioningAuthorization;

function tenantInput(
  overrides: Partial<ValidatedProvisioningInput> = {},
): ValidatedProvisioningInput {
  return {
    business_name: 'BookNowTech Internal QA',
    legal_name: null,
    slug: 'booknowtech-internal-qa',
    timezone: 'America/New_York',
    currency: 'USD',
    designation: 'internal_qa',
    contact: { email: null, phone_e164: null, website_url: null },
    owner: { display_name: 'Internal QA Owner', email: 'qa-owner@example.test' },
    fallback_hostname: 'booknowtech-internal-qa.staging.booknowtech.com',
    ...overrides,
  };
}
