import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminStore } from '../admin/store.js';
import { migrateDatabase } from '../database/migrate.js';
import type { ProvisioningAuthorization } from '../provisioning/guard.js';
import type { ValidatedProvisioningInput } from '../provisioning/input.js';
import { provisionTenant } from '../provisioning/service.js';
import { TenantHostResolver } from '../public/tenant-host-resolver.js';
import { issueChallenge, transitionDomain, verifyDomain } from './service.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('booking hostname ownership and lifecycle', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_domains_${randomUUID().replaceAll('-', '')}`);
  const now = new Date('2026-08-22T12:00:00.000Z');

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
        'tenant_booking_hostnames',
        'tenant_booking_hostname_operations',
        'audit_logs',
      ].map((name) => db.collection(name).deleteMany({})),
    );
    await provisionTenant({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      provisioningInput,
      passwordHash: 'scrypt$redacted-hash',
    });
    await db
      .collection('tenants')
      .updateOne({ slug: provisioningInput.slug }, { $set: { public_booking_enabled: true } });
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('issues a one-time challenge, verifies ownership, and completes the manually attested lifecycle', async () => {
    const requestId = randomUUID();
    const issued = await issueChallenge({
      ...common(requestId),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 7),
      now: () => now,
    });
    expect(issued).toMatchObject({
      outcome: 'completed',
      txt_record_name: '_booknowtech.booking.customer-example.com',
    });
    expect(issued.challenge_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const replay = await issueChallenge({
      ...common(requestId),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 9),
      now: () => now,
    });
    expect(replay).toMatchObject({ outcome: 'replayed', challenge_token_available: false });
    expect(replay).not.toHaveProperty('challenge_token');

    const persisted = await db
      .collection('tenant_booking_hostnames')
      .findOne({ normalized_hostname: hostname });
    const evidence = JSON.stringify(
      await Promise.all([
        db.collection('tenant_booking_hostnames').findOne({ normalized_hostname: hostname }),
        db.collection('tenant_booking_hostname_operations').findOne({ request_id: requestId }),
        db.collection('audit_logs').findOne({ request_id: requestId }),
      ]),
    );
    expect(evidence).not.toContain(issued.challenge_token);
    expect(persisted?.verification_expires_at).toEqual(
      new Date(now.valueOf() + 72 * 60 * 60 * 1_000),
    );

    const store = new AdminStore(db);
    const tenant = (await db.collection('tenants').findOne({ slug: provisioningInput.slug }))!;
    const resolver = new TenantHostResolver(store, 'staging.booknowtech.com', 'staging');
    await expect(resolver.publicBookingOrigin(tenant as never)).resolves.toBe(
      'https://internal-qa.staging.booknowtech.com',
    );

    const verified = await verifyDomain({
      ...common(randomUUID()),
      now: () => now,
      resolver: {
        resolveTxt: () =>
          Promise.resolve([['unrelated'], [`booknowtech-verification=${issued.challenge_token!}`]]),
      },
    });
    expect(verified).toMatchObject({ outcome: 'completed', state: 'verified' });
    expect(
      (await db.collection('tenant_booking_hostnames').findOne({ normalized_hostname: hostname }))
        ?.verification_expires_at,
    ).toBeNull();
    await expect(resolver.resolvePublicTenant(hostname, 'public_booking')).resolves.toBeNull();

    expect(
      await transition('begin_provisioning', { railwayMappingReference: 'railway-domain-123' }),
    ).toMatchObject({ state: 'provisioning' });
    const activated = await transitionDomain({
      ...common(randomUUID()),
      now: () => new Date(now.valueOf() + 100 * 60 * 60 * 1_000),
      operation: 'activate',
      railwayStatus: 'ready',
      tlsStatus: 'ready',
    });
    expect(activated).toMatchObject({
      state: 'active',
      operator_attested_railway_status: 'ready',
      operator_attested_tls_status: 'ready',
    });
    await expect(resolver.publicBookingOrigin(tenant as never)).resolves.toBe(
      `https://${hostname}`,
    );
    expect(await transition('deactivate')).toMatchObject({ state: 'disabled' });
    await expect(resolver.publicBookingOrigin(tenant as never)).resolves.toBe(
      'https://internal-qa.staging.booknowtech.com',
    );
    expect(await transition('begin_removal')).toMatchObject({ state: 'removing' });
    expect(await transition('complete_removal')).toMatchObject({ state: 'removed' });
    expect(await db.collection('tenant_booking_hostname_operations').countDocuments()).toBe(7);
    expect(
      await db.collection('audit_logs').countDocuments({ event: /^booking_hostname\./u }),
    ).toBe(7);
    const removed = await db
      .collection('tenant_booking_hostnames')
      .findOne({ normalized_hostname: hostname });
    expect(removed).toMatchObject({
      verified_at: null,
      railway_mapping_reference: null,
      railway_status: null,
      tls_status: null,
    });
  });

  it('classifies safe retries, expiry, invalid transitions, and request mismatches', async () => {
    const issueRequest = randomUUID();
    const issued = await issueChallenge({
      ...common(issueRequest),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 3),
      now: () => now,
    });
    const notFound = await verifyDomain({
      ...common(randomUUID()),
      now: () => now,
      resolver: {
        resolveTxt: () =>
          Promise.reject(Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' })),
      },
    });
    expect(notFound).toMatchObject({
      outcome: 'failed',
      state: 'pending_verification',
      failure_category: 'dns_record_not_found',
    });
    const mismatchRequest = randomUUID();
    const mismatch = await verifyDomain({
      ...common(mismatchRequest),
      now: () => now,
      resolver: {
        resolveTxt: () =>
          Promise.resolve([
            ['booknowtech-verification=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
          ]),
      },
    });
    expect(mismatch).toMatchObject({
      state: 'pending_verification',
      failure_category: 'dns_challenge_mismatch',
    });
    await expect(
      verifyDomain({
        ...common(mismatchRequest, 'other.customer-example.com'),
        now: () => now,
        resolver: { resolveTxt: () => Promise.resolve([]) },
      }),
    ).rejects.toMatchObject({ code: 'request_id_mismatch' });
    const expired = await verifyDomain({
      ...common(randomUUID()),
      now: () => new Date(now.valueOf() + 73 * 60 * 60 * 1_000),
      resolver: {
        resolveTxt: () =>
          Promise.resolve([[`booknowtech-verification=${issued.challenge_token!}`]]),
      },
    });
    expect(expired).toMatchObject({
      outcome: 'failed',
      state: 'failed',
      failure_category: 'verification_challenge_expired',
    });
    const refused = await transition('activate', { railwayStatus: 'ready', tlsStatus: 'ready' });
    expect(refused).toMatchObject({
      outcome: 'refused',
      state: 'failed',
      failure_category: 'invalid_transition',
    });
  });

  it('does not mutate a verified hostname when a verify shortcut is refused', async () => {
    await issueAndVerify(hostname);
    const before = await db.collection('tenant_booking_hostnames').findOne({
      normalized_hostname: hostname,
    });
    const refused = await verifyDomain({
      ...common(randomUUID()),
      now: () => new Date(now.valueOf() + 1_000),
      resolver: { resolveTxt: () => Promise.reject(new Error('must not query')) },
    });
    expect(refused).toMatchObject({
      outcome: 'refused',
      state: 'verified',
      failure_category: 'invalid_transition',
    });
    const after = await db.collection('tenant_booking_hostnames').findOne({
      normalized_hostname: hostname,
    });
    expect(after).toEqual(before);
  });

  it('rejects a stale DNS result after atomic challenge replacement', async () => {
    const first = await issueChallenge({
      ...common(randomUUID()),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 11),
      now: () => now,
    });
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const staleVerification = verifyDomain({
      ...common(randomUUID()),
      now: () => now,
      resolver: {
        resolveTxt: async () => {
          lookupStarted();
          await release;
          return [[`booknowtech-verification=${first.challenge_token!}`]];
        },
      },
    });
    await started;
    const replacement = await issueChallenge({
      ...common(randomUUID()),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 12),
      now: () => new Date(now.valueOf() + 1_000),
    });
    releaseLookup();
    await expect(staleVerification).resolves.toMatchObject({
      outcome: 'refused',
      state: 'pending_verification',
      failure_category: 'stale_verification_attempt',
    });
    await expect(
      verifyDomain({
        ...common(randomUUID()),
        now: () => new Date(now.valueOf() + 2_000),
        resolver: {
          resolveTxt: () =>
            Promise.resolve([[`booknowtech-verification=${replacement.challenge_token!}`]]),
        },
      }),
    ).resolves.toMatchObject({ outcome: 'completed', state: 'verified' });
  });

  it('enforces one concurrent active hostname with refusal evidence for the loser', async () => {
    const otherHostname = 'schedule.customer-example.com';
    await issueAndVerify(hostname);
    await transitionDomain({
      ...common(randomUUID()),
      operation: 'begin_provisioning',
      railwayMappingReference: 'railway-domain-booking',
    });
    await issueAndVerify(otherHostname);
    await transitionDomain({
      ...common(randomUUID(), otherHostname),
      operation: 'begin_provisioning',
      railwayMappingReference: 'railway-domain-schedule',
    });
    const results = await Promise.all([
      transitionDomain({
        ...common(randomUUID()),
        operation: 'activate',
        railwayStatus: 'ready',
        tlsStatus: 'ready',
      }),
      transitionDomain({
        ...common(randomUUID(), otherHostname),
        operation: 'activate',
        railwayStatus: 'ready',
        tlsStatus: 'ready',
      }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['completed', 'refused']);
    expect(results.find(({ outcome }) => outcome === 'refused')).toMatchObject({
      failure_category: 'active_hostname_conflict',
      state: 'provisioning',
    });
    expect(
      await db.collection('tenant_booking_hostnames').countDocuments({ status: 'active' }),
    ).toBe(1);
    expect(
      await db.collection('tenant_booking_hostname_operations').countDocuments({
        operation_type: 'activate',
      }),
    ).toBe(2);
    expect(
      await db.collection('audit_logs').countDocuments({
        event: { $in: ['booking_hostname.activated', 'booking_hostname.transition_refused'] },
      }),
    ).toBe(2);
  });

  it.each(['hostname', 'operation', 'audit'] as const)(
    'rolls back challenge state and all evidence when interrupted after %s',
    async (stage) => {
      await expect(
        issueChallenge({
          ...common(randomUUID()),
          tenantSlug: provisioningInput.slug,
          entropy: () => Buffer.alloc(32, 13),
          now: () => now,
          beforeCommit: (current) => {
            if (current === stage) throw new Error('interrupted');
          },
        }),
      ).rejects.toThrow('interrupted');
      expect(await db.collection('tenant_booking_hostnames').countDocuments()).toBe(0);
      expect(await db.collection('tenant_booking_hostname_operations').countDocuments()).toBe(0);
      expect(
        await db.collection('audit_logs').countDocuments({ event: /^booking_hostname\./u }),
      ).toBe(0);
    },
  );

  it('refuses an entropy provider that does not return exactly 256 bits', async () => {
    await expect(
      issueChallenge({
        ...common(randomUUID()),
        tenantSlug: provisioningInput.slug,
        entropy: () => Buffer.alloc(31, 1),
        now: () => now,
      }),
    ).rejects.toThrow('entropy generation failed');
    expect(await db.collection('tenant_booking_hostnames').countDocuments()).toBe(0);
    expect(await db.collection('tenant_booking_hostname_operations').countDocuments()).toBe(0);
  });

  it('supports approved replacement states and refuses cross-tenant reclaim', async () => {
    const expired = await issueChallenge({
      ...common(randomUUID()),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, 14),
      now: () => now,
    });
    await verifyDomain({
      ...common(randomUUID()),
      now: () => new Date(now.valueOf() + 73 * 60 * 60 * 1_000),
      resolver: {
        resolveTxt: () =>
          Promise.resolve([[`booknowtech-verification=${expired.challenge_token!}`]]),
      },
    });
    await expect(replace(15)).resolves.toMatchObject({ state: 'pending_verification' });
    const verified = await verifyCurrent(15);
    expect(verified.state).toBe('verified');
    await expect(replace(16)).resolves.toMatchObject({ state: 'pending_verification' });
    await verifyCurrent(16);
    await transition('deactivate');
    await expect(replace(17)).resolves.toMatchObject({ state: 'pending_verification' });
    await verifyCurrent(17);
    await transition('deactivate');
    await transition('begin_removal');
    await transition('complete_removal');
    await expect(replace(18)).resolves.toMatchObject({ state: 'pending_verification' });

    await provisionTenant({
      client,
      database: db,
      authorization,
      requestId: randomUUID(),
      provisioningInput: {
        ...provisioningInput,
        slug: 'other-tenant',
        owner: { display_name: 'Other Owner', email: 'other-domain-qa@example.test' },
        fallback_hostname: 'other-tenant.staging.booknowtech.com',
      },
      passwordHash: 'scrypt$redacted-hash',
    });
    await expect(
      issueChallenge({
        ...common(randomUUID()),
        tenantSlug: 'other-tenant',
        entropy: () => Buffer.alloc(32, 19),
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: 'hostname_conflict' });
  });

  function common(requestId: string, selectedHostname = hostname) {
    return { client, database: db, authorization, requestId, hostname: selectedHostname };
  }
  function transition(
    operation:
      'begin_provisioning' | 'activate' | 'deactivate' | 'begin_removal' | 'complete_removal',
    evidence: { railwayMappingReference?: string; railwayStatus?: string; tlsStatus?: string } = {},
  ) {
    return transitionDomain({ ...common(randomUUID()), operation, ...evidence });
  }
  async function issueAndVerify(selectedHostname: string) {
    const seed = selectedHostname === hostname ? 21 : 22;
    const issued = await issueChallenge({
      ...common(randomUUID(), selectedHostname),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, seed),
      now: () => now,
    });
    await verifyDomain({
      ...common(randomUUID(), selectedHostname),
      now: () => now,
      resolver: {
        resolveTxt: () =>
          Promise.resolve([[`booknowtech-verification=${issued.challenge_token!}`]]),
      },
    });
  }
  function replace(seed: number) {
    return issueChallenge({
      ...common(randomUUID()),
      tenantSlug: provisioningInput.slug,
      entropy: () => Buffer.alloc(32, seed),
      now: () => now,
    });
  }
  function verifyCurrent(seed: number) {
    const token = Buffer.alloc(32, seed).toString('base64url');
    return verifyDomain({
      ...common(randomUUID()),
      now: () => now,
      resolver: {
        resolveTxt: () => Promise.resolve([[`booknowtech-verification=${token}`]]),
      },
    });
  }
});

const hostname = 'booking.customer-example.com';
const authorization = {
  operatorId: 'operator@example.test',
  reason: 'Approved custom booking hostname lifecycle.',
  environment: { ENVIRONMENT_ID: 'staging', BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com' },
} as ProvisioningAuthorization;
const provisioningInput: ValidatedProvisioningInput = {
  business_name: 'Internal QA',
  legal_name: null,
  slug: 'internal-qa',
  timezone: 'America/New_York',
  currency: 'USD',
  designation: 'internal_qa',
  contact: { email: null, phone_e164: null, website_url: null },
  owner: { display_name: 'QA Owner', email: 'domain-qa@example.test' },
  fallback_hostname: 'internal-qa.staging.booknowtech.com',
};
