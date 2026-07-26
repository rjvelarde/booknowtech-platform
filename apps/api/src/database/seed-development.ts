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
      {
        slug: 'harbor-demo',
        display_name: 'Brazilian Wax Demo',
        services: [
          ['BRAZILIAN-WAX', 'Brazilian Wax', 30, 5500, 125, 'active'],
          ['BRAZILIAN-FIRST', 'Brazilian Wax — First Time Client', 45, 2750, 125, 'active'],
          ['FULL-FACE', 'Full Face', 30, 5500, 125, 'active'],
          ['CHEST-STOMACH', 'Chest + Stomach', 40, 6500, 125, 'inactive'],
        ] as const,
      },
      {
        slug: 'city-services-demo',
        display_name: 'Braiding Demo',
        services: [
          ['BRAID-KNOTLESS-MED', 'Medium Knotless Braids', 240, 22000, 250, 'active'],
          ['CONSULT-VIRTUAL-30', 'Virtual Consultation', 30, 4000, 125, 'inactive'],
        ] as const,
      },
    ]) {
      const tenantResult = await db.collection('tenants').findOneAndUpdate(
        { slug: tenant.slug },
        {
          $set: {
            display_name: tenant.display_name,
            legal_name: null,
            contact: { email_normalized: null, phone_e164: null, website_url: null },
            default_timezone: 'America/New_York',
            locale: 'en-US',
            currency: 'USD',
            status: 'active',
            updated_at: now,
          },
          $setOnInsert: {
            public_id: randomUUID(),
            version: 1,
            updated_by: userResult._id,
            created_at: now,
          },
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
      for (const [internalCode, name, duration, price, fee, status] of tenant.services) {
        await db.collection('services').updateOne(
          { tenant_id: tenantResult._id, internal_code: internalCode },
          {
            $set: {
              name,
              description: null,
              delivery_mode:
                internalCode === 'CONSULT-VIRTUAL-30' ? 'virtual' : 'provider_location',
              duration_minutes: duration,
              base_price_minor: price,
              booking_fee_minor: fee,
              currency: 'USD',
              status,
              updated_by: userResult._id,
              updated_at: now,
            },
            $setOnInsert: {
              _id: new ObjectId(),
              public_id: randomUUID(),
              version: 1,
              created_by: userResult._id,
              created_at: now,
            },
          },
          { upsert: true },
        );
      }
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
