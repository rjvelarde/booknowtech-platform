import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../database/migrate.js';
import { MongoRateLimiter } from './limiter.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;
const secret = 'integration-rate-limit-secret-longer-than-32-bytes';

suite('Mongo shared rate limiter', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_rate_limit_${randomUUID().replaceAll('-', '')}`);

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('uses one shared atomic count across concurrent replicas and process replacement', async () => {
    const firstReplica = new MongoRateLimiter(db, secret);
    const secondReplica = new MongoRateLimiter(db, secret);
    const now = new Date('2026-08-05T12:00:05.000Z');
    const input = {
      scope: 'public_availability',
      tenantKey: firstReplica.tenantKey('tenant.booknowtech.com'),
      subject: '203.0.113.8|tenant.booknowtech.com',
      limit: 30,
      windowMilliseconds: 60_000,
      now,
    };
    const decisions = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 === 0 ? firstReplica : secondReplica).consume(input),
      ),
    );
    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(30);
    expect(Math.max(...decisions.map(({ count }) => count))).toBe(50);

    const restartedReplica = new MongoRateLimiter(db, secret);
    const afterRestart = await restartedReplica.consume(input);
    expect(afterRestart).toMatchObject({ allowed: false, count: 51, retryAfterSeconds: 55 });
  });

  it('stores only bounded hashes and starts a new fixed window independently of TTL cleanup', async () => {
    const limiter = new MongoRateLimiter(db, secret);
    const tenantKey = limiter.tenantKey('private-tenant.booknowtech.com');
    const subject = '198.51.100.9|person@example.test|+18435550100|raw-token';
    await limiter.consume({
      scope: 'management_read',
      tenantKey,
      subject,
      limit: 1,
      windowMilliseconds: 60_000,
      now: new Date('2026-08-05T12:00:59.000Z'),
    });
    const next = await limiter.consume({
      scope: 'management_read',
      tenantKey,
      subject,
      limit: 1,
      windowMilliseconds: 60_000,
      now: new Date('2026-08-05T12:01:00.000Z'),
    });
    expect(next).toMatchObject({ allowed: true, count: 1, retryAfterSeconds: 60 });
    const documents = await db
      .collection('request_rate_limits')
      .find({ scope: 'management_read' })
      .toArray();
    expect(documents).toHaveLength(2);
    expect(JSON.stringify(documents)).not.toContain('person@example.test');
    expect(JSON.stringify(documents)).not.toContain('198.51.100.9');
    expect(JSON.stringify(documents)).not.toContain('raw-token');
    expect(
      documents.every(({ subject_hash }) => /^[a-f0-9]{64}$/u.test(String(subject_hash))),
    ).toBe(true);
  });
});
