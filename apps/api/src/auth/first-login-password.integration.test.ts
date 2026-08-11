import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminStore } from '../admin/store.js';
import { migrateDatabase } from '../database/migrate.js';
import type { ProvisioningAuthorization } from '../provisioning/guard.js';
import type { ValidatedProvisioningInput } from '../provisioning/input.js';
import { provisionTenant } from '../provisioning/service.js';
import { hashPassword, verifyPassword } from './password.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('first-login password replacement transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_first_login_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);
  const store = new AdminStore(db);

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
  });
  beforeEach(async () => {
    await Promise.all(
      [
        'admin_sessions',
        'audit_logs',
        'roles',
        'tenant_provisioning_operations',
        'tenants',
        'users',
      ].map((name) => db.collection(name).deleteMany({})),
    );
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('rotates the current session, revokes every prior session, clears the requirement, and audits safely', async () => {
    const temporaryPassword = 'Temporary password 123';
    const provisioned = await provisionTenant({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      provisioningInput: tenantInput(),
      passwordHash: await hashPassword(temporaryPassword),
    });
    const user = await db
      .collection('users')
      .findOne({ public_id: provisioned.owner_user_public_id });
    expect(user).not.toBeNull();

    const first = await store.createSession(user!._id, randomUUID());
    const second = await store.createSession(user!._id, randomUUID());
    const context = await store.hydrateSession(first.token);
    expect(context?.user.must_change_password).toBe(true);

    const newPassword = 'Replacement password 456';
    const rotated = await store.replaceInitialPassword({
      context: context!,
      passwordHash: await hashPassword(newPassword),
      requestId: randomUUID(),
    });

    expect(rotated).not.toBeNull();
    expect(await store.hydrateSession(first.token)).toBeNull();
    expect(await store.hydrateSession(second.token)).toBeNull();
    const nextContext = await store.hydrateSession(rotated!.token);
    expect(nextContext?.user.must_change_password).toBe(false);
    expect(await verifyPassword(newPassword, nextContext!.user.password_hash)).toBe(true);

    const sessions = await db.collection('admin_sessions').find({ user_id: user!._id }).toArray();
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((session) => session.revoked_at === null)).toHaveLength(1);
    expect(
      sessions.filter((session) => session.revocation_reason === 'password_replaced'),
    ).toHaveLength(2);

    const audit = await db
      .collection('audit_logs')
      .findOne({ event: 'initial_owner_password_changed' });
    expect(audit).toMatchObject({ outcome: 'success', metadata: {} });
    expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
    expect(JSON.stringify(audit)).not.toContain(newPassword);
  });
});

const authorization = {
  operatorId: 'operator@example.test',
  reason: 'Provision an internal QA tenant for password replacement validation.',
  environment: { BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' },
} as ProvisioningAuthorization;

function tenantInput(): ValidatedProvisioningInput {
  const slug = `first-login-${randomUUID().slice(0, 8)}`;
  return {
    business_name: 'First Login Internal QA',
    legal_name: null,
    slug,
    timezone: 'America/New_York',
    currency: 'USD',
    designation: 'internal_qa',
    contact: { email: null, phone_e164: null, website_url: null },
    owner: { display_name: 'Internal QA Owner', email: `qa-${randomUUID()}@example.test` },
    fallback_hostname: `${slug}.staging.booknowtech.com`,
  };
}
