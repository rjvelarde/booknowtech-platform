import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

import { hashPassword } from '../auth/password.js';
import { loadEnvironment } from '../config.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();
  if (!['development', 'test', 'staging'].includes(environment.NODE_ENV)) {
    throw new Error('Administrative seed is prohibited outside development, test, and staging');
  }
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error('SEED_ADMIN_EMAIL and a 12+ character SEED_ADMIN_PASSWORD are required');
  }

  const client = new MongoClient(environment.MONGODB_URI);
  try {
    const db = client.db(environment.MONGODB_DATABASE);
    const now = new Date();
    const passwordHash = await hashPassword(password);
    const userResult = await db.collection('users').findOneAndUpdate(
      { email_normalized: email },
      {
        $set: {
          display_name: 'Internal Test Owner',
          password_hash: passwordHash,
          status: 'active',
          updated_at: now,
        },
        $setOnInsert: { public_id: randomUUID(), created_at: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!userResult) throw new Error('Unable to create seed user');

    for (const tenant of [
      { slug: 'harbor-demo', display_name: 'Harbor Demo' },
      { slug: 'city-services-demo', display_name: 'City Services Demo' },
    ]) {
      const tenantResult = await db.collection('tenants').findOneAndUpdate(
        { slug: tenant.slug },
        {
          $set: { display_name: tenant.display_name, status: 'active', updated_at: now },
          $setOnInsert: { public_id: randomUUID(), created_at: now },
        },
        { upsert: true, returnDocument: 'after' },
      );
      if (!tenantResult) throw new Error('Unable to create seed tenant');
      await db.collection('roles').updateOne(
        { tenant_id: tenantResult._id, user_id: userResult._id, role: 'tenant_owner' },
        {
          $set: { status: 'active', updated_at: now },
          $setOnInsert: {
            _id: new ObjectId(),
            public_id: randomUUID(),
            created_at: now,
          },
        },
        { upsert: true },
      );
    }
    process.stdout.write(`Seeded internal administrative user ${email}.\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Administrative seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
