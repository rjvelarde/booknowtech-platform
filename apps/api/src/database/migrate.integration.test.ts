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
});
