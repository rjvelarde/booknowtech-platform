import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleDocument, TenantDocument, UserDocument } from '../admin/store.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { migrateDatabase } from '../database/migrate.js';
import { runProvisioningCli } from './cli.js';
import type { ProvisioningAuthorization } from './guard.js';
import type { ValidatedProvisioningInput } from './input.js';
import {
  prepareOwnerPasswordReset,
  resetOwnerPassword,
  resolveOwnerPasswordResetTarget,
} from './password-reset-service.js';
import { provisionTenant } from './service.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('audited owner password reset', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_password_reset_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);

  beforeAll(async () => {
    await client.connect();
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
        'admin_sessions',
      ].map((name) => db.collection(name).deleteMany({})),
    );
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('atomically resets one owner, forces replacement, revokes every session, and audits safely', async () => {
    const fixture = await seedOwner();
    const beforeTenant = await db.collection('tenants').findOne({ _id: fixture.tenant._id });
    const beforeRole = await db.collection('roles').findOne({ _id: fixture.role._id });
    await seedSessions(fixture.owner._id, fixture.role._id, 3);
    const temporaryPassword = 'Temporary-Owner-Reset-Password-1';
    const passwordHash = await hashPassword(temporaryPassword);
    const requestId = randomUUID();
    const preparation = await prepare(fixture, requestId);
    const result = await resetOwnerPassword({
      client,
      database: db,
      authorization,
      requestId,
      preparation,
      passwordHash,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      sessions_revoked: 3,
      active_sessions_remaining: 0,
      must_change_password: true,
    });
    const owner = await db.collection<UserDocument>('users').findOne({ _id: fixture.owner._id });
    expect(owner).toMatchObject({
      public_id: fixture.owner.public_id,
      email_normalized: fixture.owner.email_normalized,
      display_name: fixture.owner.display_name,
      must_change_password: true,
      status: 'active',
    });
    await expect(verifyPassword(temporaryPassword, owner!.password_hash)).resolves.toBe(true);
    await expect(verifyPassword(originalPassword, owner!.password_hash)).resolves.toBe(false);
    expect(
      await db
        .collection('admin_sessions')
        .countDocuments({ user_id: owner!._id, revoked_at: null }),
    ).toBe(0);
    expect(
      await db.collection('admin_sessions').countDocuments({
        user_id: owner!._id,
        revocation_reason: 'operator_password_reset',
      }),
    ).toBe(3);
    expect(await db.collection('tenants').findOne({ _id: fixture.tenant._id })).toEqual(
      beforeTenant,
    );
    expect(await db.collection('roles').findOne({ _id: fixture.role._id })).toEqual(beforeRole);

    const operation = await db
      .collection('tenant_provisioning_operations')
      .findOne({ request_id: requestId });
    const audit = await db.collection('audit_logs').findOne({ request_id: requestId });
    expect(operation).toMatchObject({
      operation_type: 'reset_owner_password',
      status: 'completed',
      tenant_public_id: fixture.tenant.public_id,
      owner_user_public_id: fixture.owner.public_id,
    });
    expect(audit).toMatchObject({
      event: 'owner_password_reset',
      outcome: 'success',
      metadata: {
        owner_email_normalized: input.owner.email,
        sessions_revoked: '3',
        active_sessions_remaining: '0',
        must_change_password: 'true',
      },
    });
    const evidence = JSON.stringify({ operation, audit, result });
    expect(evidence).not.toContain(temporaryPassword);
    expect(evidence).not.toContain(passwordHash);
    expect(evidence).not.toContain('token-hash-');
  });

  it('dry preparation resolves safe identity without changing authentication state', async () => {
    const fixture = await seedOwner();
    await seedSessions(fixture.owner._id, fixture.role._id, 1);
    const before = await db.collection('users').findOne({ _id: fixture.owner._id });
    const prepared = await prepareOwnerPasswordReset({
      database: db,
      authorization,
      requestId: randomUUID(),
      selectors: { tenantId: fixture.tenant.public_id, ownerEmail: input.owner.email },
    });
    expect(prepared.replay).toBeNull();
    expect(prepared.target).toMatchObject({
      tenantPublicId: fixture.tenant.public_id,
      ownerPublicId: fixture.owner.public_id,
      ownerEmail: input.owner.email,
    });
    expect(await db.collection('users').findOne({ _id: fixture.owner._id })).toEqual(before);
    expect(await db.collection('admin_sessions').countDocuments({ revoked_at: null })).toBe(1);
    expect(await db.collection('tenant_provisioning_operations').countDocuments()).toBe(1);
  });

  it('CLI dry validation and completed replay never collect another password', async () => {
    const fixture = await seedOwner();
    const passwordReader = vi.fn(() => Promise.reject(new Error('password reader must not run')));
    const outputs: string[] = [];
    await runProvisioningCli(
      [
        'reset-owner-password',
        '--request-id',
        randomUUID(),
        '--tenant-id',
        fixture.tenant.public_id,
        '--owner-id',
        fixture.owner.public_id,
        '--dry-validate',
      ],
      cliEnvironment(),
      {
        clientFactory: () => cliReadClient(),
        passwordReader,
        write: (value) => outputs.push(value),
      },
    );
    expect(outputs.at(-1)).toContain('"outcome":"validated"');
    expect(passwordReader).not.toHaveBeenCalled();

    const requestId = randomUUID();
    await resetOwnerPassword({
      client,
      database: db,
      authorization,
      requestId,
      preparation: await prepare(fixture, requestId),
      passwordHash: await hashPassword('Replay-Temporary-Password-1'),
    });
    await runProvisioningCli(
      [
        'reset-owner-password',
        '--request-id',
        requestId,
        '--tenant-id',
        fixture.tenant.public_id,
        '--owner-id',
        fixture.owner.public_id,
      ],
      cliEnvironment(),
      {
        clientFactory: () => cliReadClient(),
        passwordReader,
        write: (value) => outputs.push(value),
      },
    );
    expect(outputs.at(-1)).toContain('"outcome":"replayed"');
    expect(passwordReader).not.toHaveBeenCalled();
  });

  it('fails closed for wrong tenant, wrong owner, unrelated owner, and disabled owner', async () => {
    const fixture = await seedOwner();
    await expect(
      prepareOwnerPasswordReset({
        database: db,
        authorization,
        requestId: randomUUID(),
        selectors: { tenantId: randomUUID(), ownerId: fixture.owner.public_id },
      }),
    ).rejects.toMatchObject({ code: 'tenant_target_conflict' });
    await expect(
      prepareOwnerPasswordReset({
        database: db,
        authorization,
        requestId: randomUUID(),
        selectors: { tenantSlug: input.slug, ownerId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'owner_target_conflict' });

    const unrelated = await seedOwner({ slug: 'other-tenant', email: 'other@example.test' });
    await expect(
      prepareOwnerPasswordReset({
        database: db,
        authorization,
        requestId: randomUUID(),
        selectors: { tenantSlug: input.slug, ownerId: unrelated.owner.public_id },
      }),
    ).rejects.toMatchObject({ code: 'owner_target_conflict' });
    await db
      .collection('users')
      .updateOne({ _id: fixture.owner._id }, { $set: { status: 'disabled' } });
    await expect(prepare(fixture, randomUUID())).rejects.toMatchObject({
      code: 'owner_target_conflict',
    });
  });

  it('fails closed when the owner role is not active', async () => {
    const fixture = await seedOwner();
    await db
      .collection('roles')
      .updateOne({ _id: fixture.role._id }, { $set: { status: 'revoked' } });
    await expect(prepare(fixture, randomUUID())).rejects.toMatchObject({
      code: 'owner_target_conflict',
    });
  });

  it('detects ambiguous fixture resolution rather than selecting the first match', async () => {
    const ambiguousDb = client.db(`reset_amb_${randomUUID().slice(0, 8)}`);
    const tenantId = new ObjectId();
    const ownerId = new ObjectId();
    try {
      await ambiguousDb.collection('tenants').insertMany([
        { _id: tenantId, public_id: randomUUID(), slug: 'duplicate' },
        { _id: new ObjectId(), public_id: randomUUID(), slug: 'duplicate' },
      ]);
      await ambiguousDb.collection('users').insertOne({
        _id: ownerId,
        public_id: randomUUID(),
        email_normalized: 'ambiguous@example.test',
        status: 'active',
      });
      await expect(
        resolveOwnerPasswordResetTarget(ambiguousDb, {
          tenantSlug: 'duplicate',
          ownerEmail: 'ambiguous@example.test',
        }),
      ).rejects.toMatchObject({ code: 'tenant_target_conflict' });

      await ambiguousDb.collection('tenants').deleteMany({});
      await ambiguousDb.collection('users').deleteMany({});
      await ambiguousDb.collection('tenants').insertOne({
        _id: tenantId,
        public_id: randomUUID(),
        slug: 'one-tenant',
      });
      const ownerIds = [new ObjectId(), new ObjectId()];
      await ambiguousDb.collection('users').insertMany(
        ownerIds.map((_id) => ({
          _id,
          public_id: randomUUID(),
          email_normalized: 'ambiguous@example.test',
          status: 'active',
        })),
      );
      await ambiguousDb.collection('roles').insertMany(
        ownerIds.map((user_id) => ({
          tenant_id: tenantId,
          user_id,
          role: 'tenant_owner',
          status: 'active',
        })),
      );
      await expect(
        resolveOwnerPasswordResetTarget(ambiguousDb, {
          tenantSlug: 'one-tenant',
          ownerEmail: 'ambiguous@example.test',
        }),
      ).rejects.toMatchObject({ code: 'owner_target_conflict' });
    } finally {
      await ambiguousDb.dropDatabase();
    }
  });

  it('replays the same request without changing the credential and rejects UUID reuse for another target', async () => {
    const fixture = await seedOwner();
    const requestId = randomUUID();
    const preparation = await prepare(fixture, requestId);
    await resetOwnerPassword({
      client,
      database: db,
      authorization,
      requestId,
      preparation,
      passwordHash: await hashPassword('Temporary-Password-First-1'),
    });
    const afterFirst = await db.collection('users').findOne({ _id: fixture.owner._id });
    const replayPreparation = await prepare(fixture, requestId);
    expect(replayPreparation.replay?.outcome).toBe('replayed');
    const replay = await resetOwnerPassword({
      client,
      database: db,
      authorization,
      requestId,
      preparation: replayPreparation,
      passwordHash: 'must-not-be-used',
    });
    expect(replay.outcome).toBe('replayed');
    expect(await db.collection('users').findOne({ _id: fixture.owner._id })).toEqual(afterFirst);

    const other = await seedOwner({ slug: 'uuid-conflict', email: 'uuid-conflict@example.test' });
    await expect(prepare(other, requestId)).rejects.toMatchObject({ code: 'request_id_mismatch' });
  });

  it('allows exactly one successful mutation for concurrent identical execution', async () => {
    const fixture = await seedOwner();
    const requestId = randomUUID();
    const [firstPreparation, secondPreparation] = await Promise.all([
      prepare(fixture, requestId),
      prepare(fixture, requestId),
    ]);
    const results = await Promise.all([
      resetOwnerPassword({
        client,
        database: db,
        authorization,
        requestId,
        preparation: firstPreparation,
        passwordHash: await hashPassword('Concurrent-Temporary-Password-1'),
      }),
      resetOwnerPassword({
        client,
        database: db,
        authorization,
        requestId,
        preparation: secondPreparation,
        passwordHash: await hashPassword('Concurrent-Temporary-Password-1'),
      }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['completed', 'replayed']);
    expect(
      await db
        .collection('tenant_provisioning_operations')
        .countDocuments({ request_id: requestId }),
    ).toBe(1);
    expect(await db.collection('audit_logs').countDocuments({ request_id: requestId })).toBe(1);
  });

  it.each(['password', 'sessions', 'operation', 'audit'] as const)(
    'rolls back authentication and evidence when the %s stage fails',
    async (stage) => {
      const fixture = await seedOwner();
      await seedSessions(fixture.owner._id, fixture.role._id, 1);
      const before = await db.collection('users').findOne({ _id: fixture.owner._id });
      const requestId = randomUUID();
      await expect(
        resetOwnerPassword({
          client,
          database: db,
          authorization,
          requestId,
          preparation: await prepare(fixture, requestId),
          passwordHash: await hashPassword('Rollback-Temporary-Password-1'),
          hooks: {
            beforeCommit: (current) => {
              if (current === stage) throw new Error('injected');
            },
          },
        }),
      ).rejects.toBeDefined();
      expect(await db.collection('users').findOne({ _id: fixture.owner._id })).toEqual(before);
      expect(await db.collection('admin_sessions').countDocuments({ revoked_at: null })).toBe(1);
      expect(
        await db
          .collection('tenant_provisioning_operations')
          .countDocuments({ request_id: requestId }),
      ).toBe(0);
      expect(await db.collection('audit_logs').countDocuments({ request_id: requestId })).toBe(0);
    },
  );

  async function seedOwner(overrides: { slug?: string; email?: string } = {}) {
    const provisioningInput: ValidatedProvisioningInput = {
      ...input,
      slug: overrides.slug ?? input.slug,
      owner: { ...input.owner, email: overrides.email ?? input.owner.email },
      fallback_hostname: `${overrides.slug ?? input.slug}.staging.booknowtech.com`,
    };
    const provisioned = await provisionTenant({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      provisioningInput,
      passwordHash: await hashPassword(originalPassword),
    });
    const tenant = (await db
      .collection<TenantDocument>('tenants')
      .findOne({ public_id: provisioned.tenant_public_id }))!;
    const owner = (await db
      .collection<UserDocument>('users')
      .findOne({ public_id: provisioned.owner_user_public_id }))!;
    await db
      .collection('users')
      .updateOne({ _id: owner._id }, { $set: { must_change_password: false } });
    owner.must_change_password = false;
    const role = (await db
      .collection<RoleDocument>('roles')
      .findOne({ tenant_id: tenant._id, user_id: owner._id }))!;
    return { tenant, owner, role };
  }

  function prepare(fixture: Awaited<ReturnType<typeof seedOwner>>, requestId: string) {
    return prepareOwnerPasswordReset({
      database: db,
      authorization,
      requestId,
      selectors: { tenantId: fixture.tenant.public_id, ownerId: fixture.owner.public_id },
    });
  }

  async function seedSessions(userId: ObjectId, roleId: ObjectId, count: number) {
    const now = new Date();
    await db.collection('admin_sessions').insertMany(
      Array.from({ length: count }, (_, index) => ({
        _id: new ObjectId(),
        public_id: randomUUID(),
        token_hash: `${index}`.padStart(64, 'a'),
        audience: 'admin',
        user_id: userId,
        selected_membership_id: roleId,
        csrf_token_hash: `${index}`.padStart(64, 'b'),
        created_at: now,
        rotated_at: now,
        last_seen_at: now,
        expires_at: new Date(now.valueOf() + 86_400_000),
        revoked_at: null,
        revocation_reason: null,
        created_request_id: randomUUID(),
      })),
    );
  }

  function cliReadClient(): MongoClient {
    return {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      db: () => db,
    } as unknown as MongoClient;
  }
});

function cliEnvironment() {
  return {
    NODE_ENV: 'staging',
    ENVIRONMENT_ID: 'staging',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    HOST: '127.0.0.1',
    PORT: '8080',
    LOG_LEVEL: 'info',
    MONGODB_URI: uri!,
    MONGODB_DATABASE: 'booknowtech_staging',
    BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
    ADMIN_ORIGIN: 'https://admin.staging.booknowtech.com',
    TENANT_ADMIN_ENABLED: 'true',
    OPENAPI_ENABLED: 'true',
    PUBLIC_APPOINTMENT_TOKEN_SECRET: 'a-safe-public-appointment-secret-value',
    RATE_LIMIT_KEY_SECRET: 'a-different-safe-rate-limit-secret-value',
    MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
    PROVISIONING_OPERATOR_ID: authorization.operatorId,
    PROVISIONING_REASON: authorization.reason,
    PROVISIONING_APPROVED: 'true',
  };
}

const originalPassword = 'Original-Permanent-Password-1';
const authorization = {
  operatorId: 'operator@example.test',
  reason: 'Approved owner password reset for account recovery.',
  environment: { BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' },
} as ProvisioningAuthorization;
const input: ValidatedProvisioningInput = {
  business_name: 'Password Reset Tenant',
  legal_name: 'Password Reset Tenant LLC',
  slug: 'password-reset-tenant',
  timezone: 'America/New_York',
  currency: 'USD',
  designation: 'customer',
  contact: { email: null, phone_e164: null, website_url: null },
  owner: { display_name: 'Reset Owner', email: 'reset-owner@example.test' },
  fallback_hostname: 'password-reset-tenant.staging.booknowtech.com',
};
