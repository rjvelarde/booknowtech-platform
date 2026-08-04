import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

import { hashPassword } from '../auth/password.js';
import type {
  CustomerDocument,
  ProviderDocument,
  ProviderServiceAssignmentDocument,
  ServiceDocument,
} from '../admin/store.js';
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
            default_slot_cadence_minutes: tenant.slug === 'harbor-demo' ? 15 : 30,
            locale: 'en-US',
            currency: 'USD',
            public_booking_enabled: true,
            public_profile: {
              business_name: tenant.display_name,
              description:
                tenant.slug === 'harbor-demo'
                  ? 'Professional appointment services in a welcoming setting.'
                  : 'Professional braiding services with experienced providers.',
              tagline: 'Book your next appointment with confidence.',
              logo_url: null,
              primary_color: tenant.slug === 'harbor-demo' ? '#1261A0' : '#6D3FA0',
              website_url: null,
              phone_e164: null,
              email_normalized: null,
            },
            booking_policy: {
              minimum_lead_minutes: tenant.slug === 'harbor-demo' ? 120 : 240,
              maximum_advance_days: tenant.slug === 'harbor-demo' ? 90 : 120,
            },
            public_booking_terms: {
              version: 'staging-v1',
              acknowledgment_label: 'I agree to the booking terms for this appointment.',
              terms_url: null,
            },
            appointment_email_settings: {
              enabled: false,
              sender_name: tenant.display_name,
              reply_to_email: null,
            },
            appointment_self_service: {
              enabled: false,
              cancellation_cutoff_minutes: 1440,
              reschedule_cutoff_minutes: 1440,
            },
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
              slot_cadence_minutes:
                internalCode === 'CHEST-STOMACH'
                  ? 20
                  : internalCode === 'CONSULT-VIRTUAL-30'
                    ? 15
                    : null,
              currency: 'USD',
              status,
              publicly_bookable: status === 'active',
              public_display_order:
                internalCode === 'BRAZILIAN-WAX'
                  ? 10
                  : internalCode === 'BRAZILIAN-FIRST'
                    ? 20
                    : internalCode === 'FULL-FACE'
                      ? 30
                      : 40,
              public_booking_policy: {
                minimum_lead_minutes: null,
                maximum_advance_days: null,
              },
              public_self_service_policy: {
                cancellation_cutoff_minutes: null,
                reschedule_cutoff_minutes: null,
              },
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
      const customerSeeds =
        tenant.slug === 'harbor-demo'
          ? ([
              [
                'wax-maya-johnson',
                'Maya',
                'Johnson',
                'Maya',
                'maya.johnson@example.test',
                '+14045550101',
                'active',
              ],
              [
                'wax-elena-ruiz',
                'Elena',
                'Ruiz',
                null,
                'elena.ruiz@example.test',
                '+14045550102',
                'active',
              ],
              ['wax-jordan-lee', 'Jordan', 'Lee', null, null, '+14045550103', 'inactive'],
            ] as const)
          : ([
              [
                'braid-aaliyah-brooks',
                'Aaliyah',
                'Brooks',
                'Liyah',
                'aaliyah.brooks@example.test',
                '+14045550201',
                'active',
              ],
              [
                'braid-nia-carter',
                'Nia',
                'Carter',
                null,
                'nia.carter@example.test',
                '+14045550202',
                'active',
              ],
              ['braid-sam-williams', 'Sam', 'Williams', null, null, null, 'active'],
            ] as const);
      for (const [
        externalId,
        firstName,
        lastName,
        preferredName,
        customerEmail,
        phone,
        status,
      ] of customerSeeds) {
        const existing = await db.collection('customers').findOne({
          tenant_id: tenantResult._id,
          external_references: {
            $elemMatch: { system: 'booknowtech_seed', external_id: externalId },
          },
        });
        await db.collection('customers').updateOne(
          { tenant_id: tenantResult._id, public_id: existing?.public_id ?? randomUUID() },
          {
            $set: {
              first_name: firstName,
              last_name: lastName,
              preferred_name: preferredName,
              first_name_normalized: firstName.toLowerCase(),
              last_name_normalized: lastName.toLowerCase(),
              full_name_normalized: `${firstName} ${lastName}`.toLowerCase(),
              email_normalized: customerEmail,
              mobile_phone_e164: phone,
              mobile_phone_digits: phone?.replace(/\D/g, '') ?? null,
              addresses: [],
              communication_preferences: {
                preferred_channel: customerEmail ? 'email' : phone ? 'sms' : 'none',
                marketing_email: 'unknown',
                marketing_sms: 'unknown',
              },
              source: 'seed',
              external_references: [
                { system: 'booknowtech_seed', external_id: externalId, recorded_at: now },
              ],
              status,
              deactivated_at: status === 'inactive' ? now : null,
              updated_at: now,
              updated_by: userResult._id,
            },
            $setOnInsert: {
              _id: new ObjectId(),
              version: 1,
              created_at: now,
              created_by: userResult._id,
            },
          },
          { upsert: true },
        );
      }
      if (tenant.slug === 'harbor-demo') {
        const providerIds = new Map<string, ObjectId>();
        for (const [internalCode, displayName, displayOrder] of [
          ['LISA', 'Lisa', 10],
          ['SANDRA', 'Sandra', 20],
        ] as const) {
          const provider = await db.collection('providers').findOneAndUpdate(
            { tenant_id: tenantResult._id, internal_code: internalCode },
            {
              $set: {
                display_name: displayName,
                first_name: displayName,
                last_name: null,
                email_normalized: null,
                phone_e164: null,
                photo_url: null,
                bio: null,
                status: 'active',
                customer_selectable: true,
                accepting_new_clients: true,
                display_order: displayOrder,
                linked_user_id: null,
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
            { upsert: true, returnDocument: 'after' },
          );
          if (!provider) throw new Error('Unable to create seed provider');
          providerIds.set(internalCode, provider._id);
        }
        const assignments = [
          ['LISA', 'BRAZILIAN-WAX'],
          ['SANDRA', 'BRAZILIAN-WAX'],
          ['LISA', 'BRAZILIAN-FIRST'],
          ['LISA', 'FULL-FACE'],
          ['SANDRA', 'FULL-FACE'],
          ['SANDRA', 'CHEST-STOMACH'],
        ] as const;
        for (const [providerCode, serviceCode] of assignments) {
          const service = await db.collection('services').findOne({
            tenant_id: tenantResult._id,
            internal_code: serviceCode,
          });
          const providerId = providerIds.get(providerCode);
          if (!service || !providerId) throw new Error('Unable to resolve seed assignment');
          await db.collection('provider_service_assignments').updateOne(
            { tenant_id: tenantResult._id, provider_id: providerId, service_id: service._id },
            {
              $set: {
                buffer_before_minutes:
                  providerCode === 'LISA' && serviceCode === 'BRAZILIAN-WAX' ? 5 : 0,
                buffer_after_minutes: serviceCode === 'BRAZILIAN-WAX' ? 10 : 0,
                updated_by: userResult._id,
                updated_at: now,
              },
              $setOnInsert: {
                _id: new ObjectId(),
                public_id: randomUUID(),
                status: 'active',
                version: 1,
                created_by: userResult._id,
                created_at: now,
              },
            },
            { upsert: true },
          );
        }
        for (const [providerCode, weeklyHours, breaks] of [
          [
            'LISA',
            [1, 2, 3, 4, 5].map((day_of_week) => ({
              day_of_week,
              start_minute: 540,
              end_minute: 1020,
            })),
            [1, 2, 3, 4, 5].map((day_of_week) => ({
              day_of_week,
              start_minute: 720,
              end_minute: 750,
            })),
          ],
          [
            'SANDRA',
            [2, 3, 4, 5, 6].map((day_of_week) => ({
              day_of_week,
              start_minute: 600,
              end_minute: 1080,
            })),
            [2, 3, 4, 5, 6].map((day_of_week) => ({
              day_of_week,
              start_minute: 780,
              end_minute: 810,
            })),
          ],
        ] as const) {
          const providerId = providerIds.get(providerCode)!;
          await db.collection('provider_availability_schedules').updateOne(
            { tenant_id: tenantResult._id, provider_id: providerId },
            {
              $set: {
                timezone: 'America/New_York',
                weekly_hours: weeklyHours,
                breaks,
                updated_at: now,
                updated_by: userResult._id,
              },
              $setOnInsert: {
                _id: new ObjectId(),
                public_id: randomUUID(),
                version: 1,
                created_at: now,
                created_by: userResult._id,
              },
            },
            { upsert: true },
          );
        }
        const lisaId = providerIds.get('LISA')!;
        for (const exception of [
          {
            seed_key: 'NEW-YEAR-2027',
            scope: 'tenant',
            provider_id: null,
            kind: 'holiday',
            name: "New Year's Day",
            starts_on: '2027-01-01',
            ends_before: '2027-01-02',
          },
          {
            seed_key: 'LISA-2027-01-15',
            scope: 'provider',
            provider_id: lisaId,
            kind: 'time_off',
            name: 'Time off',
            starts_on: '2027-01-15',
            ends_before: '2027-01-16',
          },
        ] as const) {
          await db.collection('availability_exceptions').updateOne(
            { tenant_id: tenantResult._id, seed_key: exception.seed_key },
            {
              $set: {
                ...exception,
                all_day: true,
                timezone: 'America/New_York',
                starts_at: null,
                ends_at: null,
                status: 'active',
                updated_at: now,
                updated_by: userResult._id,
              },
              $setOnInsert: {
                _id: new ObjectId(),
                public_id: randomUUID(),
                version: 1,
                created_at: now,
                created_by: userResult._id,
              },
            },
            { upsert: true },
          );
        }
      }
      if (tenant.slug === 'city-services-demo') {
        const braider = await db.collection('providers').findOneAndUpdate(
          { tenant_id: tenantResult._id, internal_code: 'NIA' },
          {
            $set: {
              display_name: 'Nia',
              first_name: 'Nia',
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
          { upsert: true, returnDocument: 'after' },
        );
        const service = await db.collection('services').findOne({
          tenant_id: tenantResult._id,
          internal_code: 'BRAID-KNOTLESS-MED',
        });
        if (!braider || !service) throw new Error('Unable to resolve braiding appointment seed');
        await db.collection('provider_service_assignments').updateOne(
          { tenant_id: tenantResult._id, provider_id: braider._id, service_id: service._id },
          {
            $set: {
              buffer_before_minutes: 15,
              buffer_after_minutes: 15,
              status: 'active',
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
        await db.collection('provider_availability_schedules').updateOne(
          { tenant_id: tenantResult._id, provider_id: braider._id },
          {
            $set: {
              timezone: 'America/New_York',
              weekly_hours: [2, 3, 4, 5, 6].map((day_of_week) => ({
                day_of_week,
                start_minute: 540,
                end_minute: 1080,
              })),
              breaks: [],
              updated_at: now,
              updated_by: userResult._id,
            },
            $setOnInsert: {
              _id: new ObjectId(),
              public_id: randomUUID(),
              version: 1,
              created_at: now,
              created_by: userResult._id,
            },
          },
          { upsert: true },
        );
      }

      const seedProvider = await db.collection<ProviderDocument>('providers').findOne({
        tenant_id: tenantResult._id,
        internal_code: tenant.slug === 'harbor-demo' ? 'LISA' : 'NIA',
      });
      const seedService = await db.collection<ServiceDocument>('services').findOne({
        tenant_id: tenantResult._id,
        internal_code: tenant.slug === 'harbor-demo' ? 'BRAZILIAN-WAX' : 'BRAID-KNOTLESS-MED',
      });
      const seedCustomer = await db
        .collection<CustomerDocument>('customers')
        .findOne({ tenant_id: tenantResult._id, status: 'active' });
      if (!seedProvider || !seedService || !seedCustomer)
        throw new Error('Unable to resolve appointment seed subjects');
      const publicCustomerExternalId = `${tenant.slug}-public-booking-guest`;
      await db.collection<CustomerDocument>('customers').updateOne(
        {
          tenant_id: tenantResult._id,
          external_references: {
            $elemMatch: { system: 'booknowtech_seed', external_id: publicCustomerExternalId },
          },
        },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            public_id: randomUUID(),
            tenant_id: tenantResult._id,
            first_name: 'Public',
            last_name: 'Guest',
            preferred_name: null,
            first_name_normalized: 'public',
            last_name_normalized: 'guest',
            full_name_normalized: 'public guest',
            email_normalized: `public-${tenant.slug}@example.test`,
            mobile_phone_e164: tenant.slug === 'harbor-demo' ? '+18435550141' : '+18435550142',
            mobile_phone_digits: tenant.slug === 'harbor-demo' ? '18435550141' : '18435550142',
            addresses: [],
            communication_preferences: {
              preferred_channel: 'email',
              marketing_email: 'unknown',
              marketing_sms: 'unknown',
            },
            source: 'public_booking',
            external_references: [
              {
                system: 'booknowtech_seed',
                external_id: publicCustomerExternalId,
                recorded_at: now,
              },
            ],
            status: 'active',
            deactivated_at: null,
            version: 1,
            created_at: now,
            updated_at: now,
            created_by: null,
            updated_by: null,
          },
        },
        { upsert: true },
      );
      const publicSeedCustomer = await db.collection<CustomerDocument>('customers').findOne({
        tenant_id: tenantResult._id,
        external_references: {
          $elemMatch: { system: 'booknowtech_seed', external_id: publicCustomerExternalId },
        },
      });
      if (!publicSeedCustomer)
        throw new Error('Unable to resolve public appointment seed customer');
      const seedAssignment = await db
        .collection<ProviderServiceAssignmentDocument>('provider_service_assignments')
        .findOne({
          tenant_id: tenantResult._id,
          provider_id: seedProvider._id,
          service_id: seedService._id,
        });
      if (!seedAssignment) throw new Error('Unable to resolve appointment seed assignment');
      const tenantPrefix = tenant.slug === 'harbor-demo' ? 'A' : 'B';
      for (const [sequence, status, startsAtValue] of [
        [1, 'scheduled', '2027-02-02T15:00:00.000Z'],
        [2, 'completed', '2026-06-02T15:00:00.000Z'],
        [3, 'cancelled', '2026-06-03T15:00:00.000Z'],
        [4, 'no_show', '2026-06-04T15:00:00.000Z'],
      ] as const) {
        const startsAt = new Date(startsAtValue);
        const before = seedAssignment.buffer_before_minutes;
        const after = seedAssignment.buffer_after_minutes;
        const duration = seedService.duration_minutes;
        const reference = `BNT-${tenantPrefix}${String(sequence).padStart(7, '0')}`;
        const terminalAt = status === 'scheduled' ? null : startsAt;
        await db.collection('appointments').updateOne(
          { tenant_id: tenantResult._id, reference },
          {
            $setOnInsert: {
              _id: new ObjectId(),
              public_id: randomUUID(),
              reference,
              tenant_id: tenantResult._id,
              customer_id: seedCustomer._id,
              provider_id: seedProvider._id,
              service_id: seedService._id,
              provider_service_assignment_id: seedAssignment._id,
              starts_at: startsAt,
              ends_at: new Date(startsAt.valueOf() + duration * 60_000),
              blocked_starts_at: new Date(startsAt.valueOf() - before * 60_000),
              blocked_ends_at: new Date(startsAt.valueOf() + (duration + after) * 60_000),
              timezone: 'America/New_York',
              local_start_date: startsAtValue.slice(0, 10),
              snapshot: {
                customer_display_name:
                  `${seedCustomer.preferred_name ?? seedCustomer.first_name} ${seedCustomer.last_name ?? ''}`.trim(),
                provider_display_name: seedProvider.display_name,
                service_name: seedService.name,
                service_duration_minutes: duration,
                slot_cadence_minutes:
                  seedService.slot_cadence_minutes ?? (tenant.slug === 'harbor-demo' ? 15 : 30),
                buffer_before_minutes: before,
                buffer_after_minutes: after,
                delivery_mode: seedService.delivery_mode,
                base_price_minor: seedService.base_price_minor,
                booking_fee_minor: seedService.booking_fee_minor,
                currency: seedService.currency,
                customer_note: null,
              },
              location: { mode: seedService.delivery_mode, customer_address: null },
              status,
              source: 'seed',
              public_submission: null,
              booking_terms: null,
              cancelled_at: status === 'cancelled' ? terminalAt : null,
              cancelled_by: status === 'cancelled' ? userResult._id : null,
              cancellation_reason: status === 'cancelled' ? 'customer_request' : null,
              cancellation_detail: null,
              completed_at: status === 'completed' ? terminalAt : null,
              completed_by: status === 'completed' ? userResult._id : null,
              no_show_at: status === 'no_show' ? terminalAt : null,
              no_show_by: status === 'no_show' ? userResult._id : null,
              version: 1,
              created_at: now,
              updated_at: now,
              created_by: userResult._id,
              updated_by: userResult._id,
            },
          },
          { upsert: true },
        );
      }
      const publicStartsAt = new Date('2027-02-03T15:00:00.000Z');
      const publicReference = `BNT-${tenantPrefix}0000005`;
      const publicDuration = seedService.duration_minutes;
      await db.collection('appointments').updateOne(
        { tenant_id: tenantResult._id, reference: publicReference },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            public_id: randomUUID(),
            reference: publicReference,
            tenant_id: tenantResult._id,
            customer_id: publicSeedCustomer._id,
            provider_id: seedProvider._id,
            service_id: seedService._id,
            provider_service_assignment_id: seedAssignment._id,
            starts_at: publicStartsAt,
            ends_at: new Date(publicStartsAt.valueOf() + publicDuration * 60_000),
            blocked_starts_at: new Date(
              publicStartsAt.valueOf() - seedAssignment.buffer_before_minutes * 60_000,
            ),
            blocked_ends_at: new Date(
              publicStartsAt.valueOf() +
                (publicDuration + seedAssignment.buffer_after_minutes) * 60_000,
            ),
            timezone: 'America/New_York',
            local_start_date: '2027-02-03',
            snapshot: {
              customer_display_name: 'Public Guest',
              provider_display_name: seedProvider.display_name,
              service_name: seedService.name,
              service_duration_minutes: publicDuration,
              slot_cadence_minutes:
                seedService.slot_cadence_minutes ?? (tenant.slug === 'harbor-demo' ? 15 : 30),
              buffer_before_minutes: seedAssignment.buffer_before_minutes,
              buffer_after_minutes: seedAssignment.buffer_after_minutes,
              delivery_mode: seedService.delivery_mode,
              base_price_minor: seedService.base_price_minor,
              booking_fee_minor: seedService.booking_fee_minor,
              currency: seedService.currency,
              customer_note: 'Seeded public appointment for staging QA.',
            },
            location: { mode: seedService.delivery_mode, customer_address: null },
            status: 'scheduled',
            source: 'public_booking',
            public_submission: {
              idempotency_key_hash: createHash('sha256')
                .update(`seed-public-key:${tenant.slug}`)
                .digest('hex'),
              request_fingerprint: createHash('sha256')
                .update(`seed-public-request:${tenant.slug}`)
                .digest('hex'),
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
