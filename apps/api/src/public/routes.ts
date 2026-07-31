import { createHash, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ClientSession, ObjectId } from 'mongodb';

import type {
  AdminStore,
  AppointmentDocument,
  CustomerAddressDocument,
  CustomerDocument,
  ProviderDocument,
  ProviderServiceAssignmentDocument,
  ServiceDocument,
  TenantDocument,
} from '../admin/store.js';
import { dateRange, generateSlots, localToUtc, previewDay } from '../availability/routes.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

const managers = new Set(['tenant_owner', 'tenant_admin']);
const reservedLabels = new Set(['admin', 'api', 'www']);
const PUBLIC_SUFFIX = '.booknowtech.com';
const PLATFORM_MINIMUM_LEAD_MINUTES = 120;
const PLATFORM_MAXIMUM_ADVANCE_DAYS = 90;
const MAXIMUM_RANGE_DAYS = 14;
const MAXIMUM_STARTS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const publicAppointmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'service_public_id',
    'provider_public_id',
    'starts_at',
    'customer',
    'consent',
    'website',
  ],
  properties: {
    service_public_id: { type: 'string', minLength: 1, maxLength: 100 },
    provider_public_id: { type: 'string', minLength: 1, maxLength: 100 },
    starts_at: { type: 'string', format: 'date-time' },
    website: { type: 'string', maxLength: 200 },
    customer: {
      type: 'object',
      additionalProperties: false,
      required: [
        'first_name',
        'last_name',
        'email',
        'mobile_phone',
        'preferred_contact_channel',
        'customer_location_address',
      ],
      properties: {
        first_name: { type: 'string', minLength: 1, maxLength: 100 },
        last_name: { type: 'string', minLength: 1, maxLength: 100 },
        email: { type: 'string', minLength: 3, maxLength: 320 },
        mobile_phone: { type: 'string', minLength: 7, maxLength: 32 },
        preferred_contact_channel: { enum: ['email', 'sms'] },
        appointment_note: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] },
        customer_location_address: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['line_1', 'city', 'region', 'postal_code', 'country_code'],
              properties: {
                line_1: { type: 'string', minLength: 1, maxLength: 200 },
                line_2: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
                city: { type: 'string', minLength: 1, maxLength: 200 },
                region: { type: 'string', minLength: 1, maxLength: 200 },
                postal_code: { type: 'string', minLength: 1, maxLength: 32 },
                country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
              },
            },
          ],
        },
      },
    },
    consent: {
      type: 'object',
      additionalProperties: false,
      required: ['booking_terms_version', 'booking_terms_accepted'],
      properties: {
        booking_terms_version: { type: 'string', minLength: 1, maxLength: 64 },
        booking_terms_accepted: { const: true },
      },
    },
  },
} as const;

interface StartsQuery {
  start_date: string;
  end_date: string;
  limit?: number | string;
  cursor?: string;
}

interface PublicSettingsBody {
  expected_version: number;
  public_booking_enabled: boolean;
  public_profile: TenantDocument['public_profile'];
  booking_policy: TenantDocument['booking_policy'];
  public_booking_terms: TenantDocument['public_booking_terms'];
}

interface ServicePublicSettingsBody {
  expected_version: number;
  publicly_bookable: boolean;
  public_display_order: number;
  public_booking_policy: ServiceDocument['public_booking_policy'];
}

interface PublicAppointmentBody {
  service_public_id: string;
  provider_public_id: string;
  starts_at: string;
  customer: {
    first_name: string;
    last_name: string;
    email: string;
    mobile_phone: string;
    preferred_contact_channel: 'email' | 'sms';
    customer_location_address: PublicAddressBody | null;
    appointment_note?: string | null;
  };
  consent: { booking_terms_version: string; booking_terms_accepted: boolean };
  website: string;
}

interface PublicAddressBody {
  line_1: string;
  line_2?: string | null;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
}

export function registerPublicBookingRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  const limiter = createPublicRateLimiter();
  const submissionLimiter = createPublicRateLimiter();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/public/')) return;
    const hostname = normalizePublicHostname(request.hostname) ?? 'invalid';
    const route = request.routeOptions.url ?? request.url.split('?')[0]!;
    const maximum = route.endsWith('/available-starts') ? 30 : 120;
    if (!limiter.allow(`${request.ip}:${hostname}:${route}`, maximum, 60_000)) {
      void reply.header('Retry-After', '60');
      return safeError(reply, 429, 'public_rate_limit_exceeded', request.id);
    }
    if (request.method === 'POST' && route === '/api/v1/public/appointments') {
      const actor = `${request.ip}:${hostname}:public-appointment`;
      const tenant = `${hostname}:public-appointment`;
      if (
        !submissionLimiter.allow(`${actor}:10m`, 5, 10 * 60_000) ||
        !submissionLimiter.allow(`${actor}:24h`, 20, 24 * 60 * 60_000) ||
        !submissionLimiter.allow(`${tenant}:10m`, 120, 10 * 60_000)
      ) {
        void reply.header('Retry-After', '600');
        return safeError(reply, 429, 'public_rate_limit_exceeded', request.id);
      }
    }
  });

  app.get(
    '/api/v1/public/booking-context',
    publicSchema('getPublicBookingContext'),
    async (request, reply) => {
      const tenant = await resolvePublicTenant(request, reply, store);
      if (!tenant) return;
      return cacheablePublicReply(request, reply, bookingContextView(tenant));
    },
  );

  app.get(
    '/api/v1/public/services',
    publicSchema('listPublicBookingServices'),
    async (request, reply) => {
      const tenant = await resolvePublicTenant(request, reply, store);
      if (!tenant) return;
      const services = await store.listPublicServices(tenant._id);
      return cacheablePublicReply(request, reply, {
        items: services.map((service) => publicServiceView(service, tenant)),
      });
    },
  );

  app.get<{ Params: { servicePublicId: string } }>(
    '/api/v1/public/services/:servicePublicId/providers',
    publicSchema('listPublicBookingProviders'),
    async (request, reply) => {
      const tenant = await resolvePublicTenant(request, reply, store);
      if (!tenant) return;
      const service = await publicService(store, tenant, request.params.servicePublicId);
      if (!service) return safeResourceNotFound(reply, request.id);
      const providers = await store.listPublicProvidersForService(tenant._id, service._id);
      return cacheablePublicReply(request, reply, {
        service: { public_id: service.public_id, name: service.name },
        items: providers.map(({ provider }) => ({
          public_id: provider.public_id,
          display_name: provider.display_name,
          bio: provider.bio,
          photo_url: provider.photo_url,
        })),
      });
    },
  );

  app.get<{
    Params: { servicePublicId: string; providerPublicId: string };
    Querystring: StartsQuery;
  }>(
    '/api/v1/public/services/:servicePublicId/providers/:providerPublicId/available-starts',
    publicSchema('listPublicAvailableStarts', {
      type: 'object',
      additionalProperties: false,
      required: ['start_date', 'end_date'],
      properties: {
        start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        cursor: { type: 'string', minLength: 1, maxLength: 2048 },
      },
    }),
    async (request, reply) => {
      const started = performance.now();
      const tenant = await resolvePublicTenant(request, reply, store);
      if (!tenant) return;
      const service = await publicService(store, tenant, request.params.servicePublicId);
      if (!service) return safeResourceNotFound(reply, request.id);
      const providers = await store.listPublicProvidersForService(tenant._id, service._id);
      const subject = providers.find(
        ({ provider }) => provider.public_id === request.params.providerPublicId,
      );
      if (!subject) return safeResourceNotFound(reply, request.id);
      const dates = dateRange(request.query.start_date, request.query.end_date);
      if (!dates || dates.length > MAXIMUM_RANGE_DAYS)
        return safeError(reply, 400, 'invalid_public_availability_request', request.id);
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_STARTS)
        return safeError(reply, 400, 'invalid_public_availability_request', request.id);
      const schedule = await store.getAvailabilitySchedule(tenant._id, subject.provider._id);
      if (!schedule || !schedule.weekly_hours.length)
        return uncacheablePublicReply(
          reply,
          { timezone: tenant.default_timezone, items: [] },
          request.id,
        );
      const policy = effectivePolicy(tenant, service);
      const now = new Date();
      const today = localDate(now, tenant.default_timezone);
      const lastDate = addLocalDays(today, policy.maximum_advance_days);
      if (request.query.start_date < today || request.query.end_date > lastDate)
        return safeError(reply, 400, 'invalid_public_availability_request', request.id);

      const previewStart = localToUtc(request.query.start_date, 0, schedule.timezone, 'earlier');
      const afterEndDate = addLocalDays(request.query.end_date, 1);
      const previewEnd = localToUtc(afterEndDate, 0, schedule.timezone, 'later');
      const exceptions = (
        await store.listAvailabilityExceptions(tenant._id, subject.provider._id)
      ).filter((item) => item.status === 'active');
      const appointments = await store.listBlockingAppointments({
        tenantId: tenant._id,
        providerId: subject.provider._id,
        startsBefore: previewEnd,
        endsAfter: previewStart,
      });
      const appointmentRevisions = await store.getScheduleLockRevisions(
        tenant._id,
        subject.provider._id,
        utcDatesBetween(previewStart, previewEnd),
      );
      const cadence = service.slot_cadence_minutes ?? tenant.default_slot_cadence_minutes;
      const minimumStart = new Date(now.valueOf() + policy.minimum_lead_minutes * 60_000);
      const fingerprint = hash({
        tenant: tenant.public_id,
        service: `${service.public_id}:${service.version}`,
        provider: `${subject.provider.public_id}:${subject.provider.version}`,
        assignment: `${subject.assignment.public_id}:${subject.assignment.version}`,
        schedule: schedule.version,
        exceptions: exceptions.map((item) => `${item.public_id}:${item.version}`).sort(),
        appointmentRevisions,
        range: [request.query.start_date, request.query.end_date],
        policy,
      });
      const after = decodeCursor(request.query.cursor, fingerprint);
      if (request.query.cursor && !after)
        return safeError(reply, 400, 'invalid_public_availability_request', request.id);
      const generated: ReturnType<typeof generateSlots> = [];
      for (const date of dates) {
        const slots = generateSlots(
          previewDay(
            date,
            schedule,
            exceptions,
            service.duration_minutes,
            subject.assignment.buffer_before_minutes,
            subject.assignment.buffer_after_minutes,
          ).windows,
          schedule.timezone,
          cadence,
          service.duration_minutes,
          subject.assignment.buffer_before_minutes,
          subject.assignment.buffer_after_minutes,
          after,
        ).filter(
          (slot) =>
            new Date(slot.starts_at) >= minimumStart &&
            !appointments.some(
              (appointment) =>
                appointment.blocked_starts_at < new Date(slot.blocked_ends_at) &&
                appointment.blocked_ends_at > new Date(slot.blocked_starts_at),
            ),
        );
        generated.push(...slots.slice(0, limit + 1 - generated.length));
        if (generated.length > limit) break;
      }
      const items = generated.slice(0, limit).map((slot) => ({
        starts_at: slot.starts_at,
        ends_at: slot.service_ends_at,
        local_start: slot.local_start,
        timezone: schedule.timezone,
      }));
      const nextCursor =
        generated.length > limit ? encodeCursor(fingerprint, items.at(-1)!.starts_at) : null;
      request.log.info({
        event: 'public_booking.available_starts_generated',
        duration_ms: Math.round((performance.now() - started) * 100) / 100,
        slot_count: items.length,
        date_count: dates.length,
        outcome: 'success',
      });
      return uncacheablePublicReply(
        reply,
        { timezone: schedule.timezone, policy, items },
        request.id,
        nextCursor,
      );
    },
  );

  app.post<{ Body: PublicAppointmentBody }>(
    '/api/v1/public/appointments',
    {
      ...publicSchema('createPublicAppointment'),
      bodyLimit: 16 * 1024,
      schema: {
        operationId: 'createPublicAppointment',
        tags: ['public-booking'],
        body: publicAppointmentSchema,
      },
    },
    async (request, reply) => {
      if (!isPublicJsonRequest(request) || !isSamePublicOrigin(request))
        return safeError(reply, 403, 'invalid_public_booking_request', request.id);
      const tenant = await resolvePublicTenant(request, reply, store);
      if (!tenant) return;
      if (request.body.website)
        return safeError(reply, 400, 'invalid_public_booking_request', request.id);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !UUID_PATTERN.test(key))
        return safeError(reply, 400, 'invalid_public_booking_request', request.id);
      const normalized = normalizePublicAppointment(request.body);
      if (!normalized) return safeError(reply, 400, 'invalid_public_booking_request', request.id);
      const keyHash = createHash('sha256').update(key).digest('hex');
      const fingerprint = hash(normalized);
      const replay = await store.getPublicAppointmentByIdempotency(tenant._id, keyHash);
      if (replay) {
        if (replay.public_submission?.request_fingerprint !== fingerprint)
          return safeError(reply, 409, 'idempotency_key_reused', request.id);
        const replayProvider = await store.getProviderById(tenant._id, replay.provider_id);
        return reply
          .status(200)
          .send(envelope(publicConfirmation(replay, tenant, replayProvider, true), request.id));
      }

      const initialService = await publicService(store, tenant, normalized.service_public_id);
      if (!initialService) return safeResourceNotFound(reply, request.id);
      const initialProviders = await store.listPublicProvidersForService(
        tenant._id,
        initialService._id,
      );
      const initialSubject = initialProviders.find(
        ({ provider }) => provider.public_id === normalized.provider_public_id,
      );
      if (!initialSubject) return safeResourceNotFound(reply, request.id);
      const startsAt = new Date(normalized.starts_at);
      const preliminaryStart = new Date(
        startsAt.valueOf() - initialSubject.assignment.buffer_before_minutes * 60_000,
      );
      const preliminaryEnd = new Date(
        startsAt.valueOf() +
          (initialService.duration_minutes + initialSubject.assignment.buffer_after_minutes) *
            60_000,
      );

      try {
        const result = await store.withAppointmentScheduleLocks(
          tenant._id,
          utcDateScopes(initialSubject.provider._id, preliminaryStart, preliminaryEnd),
          async (session) => {
            const currentTenant = await store.getPublicTenantBySlug(tenant.slug, session);
            if (!currentTenant) throw new PublicBookingError(404, 'public_booking_not_found');
            if (
              currentTenant.public_booking_terms.version !==
              normalized.consent.booking_terms_version
            )
              throw new PublicBookingError(409, 'booking_terms_changed');
            const existing = await store.getPublicAppointmentByIdempotency(
              currentTenant._id,
              keyHash,
              session,
            );
            if (existing) {
              if (existing.public_submission?.request_fingerprint !== fingerprint)
                throw new PublicBookingError(409, 'idempotency_key_reused');
              return {
                appointment: existing,
                provider: await store.getProviderById(
                  currentTenant._id,
                  existing.provider_id,
                  session,
                ),
                replayed: true,
              };
            }
            const service = await store.getService(
              currentTenant._id,
              normalized.service_public_id,
              session,
            );
            const provider = await store.getProvider(
              currentTenant._id,
              normalized.provider_public_id,
              session,
            );
            if (!service || service.status !== 'active' || !service.publicly_bookable)
              throw new PublicBookingError(404, 'public_booking_not_found');
            if (
              !provider ||
              provider.status !== 'active' ||
              !provider.customer_selectable ||
              !provider.accepting_new_clients
            )
              throw new PublicBookingError(404, 'public_booking_not_found');
            const assignment = await store.findAppointmentAssignment(
              currentTenant._id,
              provider._id,
              service._id,
              session,
            );
            if (!assignment || assignment.status !== 'active')
              throw new PublicBookingError(404, 'public_booking_not_found');
            if (
              (service.delivery_mode === 'customer_location') !==
              Boolean(normalized.customer.customer_location_address)
            )
              throw new PublicBookingError(400, 'invalid_public_booking_request');
            const candidate = await validatePublicCandidate(
              store,
              currentTenant,
              service,
              provider,
              assignment,
              startsAt,
              session,
            );
            const customer = await resolvePublicCustomer(
              store,
              currentTenant._id,
              normalized,
              session,
            );
            const now = new Date();
            const appointment = await store.insertAppointment(
              {
                tenant_id: currentTenant._id,
                customer_id: customer._id,
                provider_id: provider._id,
                service_id: service._id,
                provider_service_assignment_id: assignment._id,
                ...candidate,
                snapshot: {
                  customer_display_name:
                    `${customer.preferred_name ?? customer.first_name} ${customer.last_name ?? ''}`.trim(),
                  provider_display_name: provider.display_name,
                  service_name: service.name,
                  service_duration_minutes: service.duration_minutes,
                  slot_cadence_minutes:
                    service.slot_cadence_minutes ?? currentTenant.default_slot_cadence_minutes,
                  buffer_before_minutes: assignment.buffer_before_minutes,
                  buffer_after_minutes: assignment.buffer_after_minutes,
                  delivery_mode: service.delivery_mode,
                  base_price_minor: service.base_price_minor,
                  booking_fee_minor: service.booking_fee_minor,
                  currency: service.currency,
                  customer_note: normalized.customer.appointment_note,
                },
                location: {
                  mode: service.delivery_mode,
                  customer_address: normalized.customer.customer_location_address,
                },
                status: 'scheduled',
                source: 'public_booking',
                public_submission: {
                  idempotency_key_hash: keyHash,
                  request_fingerprint: fingerprint,
                },
                booking_terms: {
                  version: currentTenant.public_booking_terms.version,
                  accepted_at: now,
                },
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
              session,
            );
            return { appointment, provider, replayed: false };
          },
        );
        if (!result.replayed)
          await store.audit({
            event: 'public_appointment_created',
            outcome: 'success',
            actorUserId: null,
            tenantId: tenant._id,
            requestId: request.id,
            metadata: {
              appointment_public_id: result.appointment.public_id,
              appointment_reference: result.appointment.reference,
            },
          });
        return reply
          .status(result.replayed ? 200 : 201)
          .send(
            envelope(
              publicConfirmation(result.appointment, tenant, result.provider, result.replayed),
              request.id,
            ),
          );
      } catch (reason) {
        if (reason instanceof PublicBookingError)
          return safeError(reply, reason.status, reason.code, request.id);
        const afterRace = await store.getPublicAppointmentByIdempotency(tenant._id, keyHash);
        if (afterRace && afterRace.public_submission?.request_fingerprint === fingerprint) {
          const replayProvider = await store.getProviderById(tenant._id, afterRace.provider_id);
          return reply
            .status(200)
            .send(
              envelope(publicConfirmation(afterRace, tenant, replayProvider, true), request.id),
            );
        }
        request.log.error({
          event: 'public_booking.create_failed',
          error_name: errorName(reason),
          ...safeMongoErrorDetails(reason),
        });
        return safeError(reply, 500, 'public_booking_failed', request.id);
      }
    },
  );

  registerAdministrativeConfiguration(app, environment, store);
}

function isPublicJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return (
    typeof contentType === 'string' && contentType.toLowerCase().startsWith('application/json')
  );
}

function isSamePublicOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const originUrl = new URL(origin);
    const requestHost = (request.headers.host ?? request.hostname).trim().toLowerCase();
    return originUrl.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

function registerAdministrativeConfiguration(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get('/api/v1/admin/public-booking-settings', async (request, reply) => {
    const context = await requireAdmin(request, reply, store, false, environment);
    if (!context) return;
    return reply.send(envelope(adminSettingsView(context.tenant!), request.id));
  });
  app.patch<{ Body: PublicSettingsBody }>(
    '/api/v1/admin/public-booking-settings',
    async (request, reply) => {
      const context = await requireAdmin(request, reply, store, true, environment);
      if (!context) return;
      const changes = normalizePublicSettings(request.body, context.tenant!);
      if (!changes) return safeError(reply, 400, 'validation_failed', request.id);
      const result = await store.updatePublicBookingSettings({
        tenantId: context.tenant!._id,
        userId: context.user._id,
        expectedVersion: request.body.expected_version,
        changes,
      });
      if (result === 'not_found') return adminNotFound(reply, request.id);
      if (result === 'version_conflict') return safeError(reply, 409, result, request.id);
      const updated = await store.getBusinessProfile(context.tenant!._id);
      if (result === 'updated')
        await store.audit({
          event:
            context.tenant!.public_booking_enabled === changes.public_booking_enabled
              ? 'public_booking_profile_updated'
              : 'public_booking_publication_changed',
          outcome: 'success',
          actorUserId: context.user._id,
          tenantId: context.tenant!._id,
          requestId: request.id,
          metadata: { public_booking_enabled: String(changes.public_booking_enabled) },
        });
      return reply.send(
        envelope({ ...adminSettingsView(updated!), changed: result === 'updated' }, request.id),
      );
    },
  );
  app.patch<{ Params: { servicePublicId: string }; Body: ServicePublicSettingsBody }>(
    '/api/v1/admin/services/:servicePublicId/public-booking',
    async (request, reply) => {
      const context = await requireAdmin(request, reply, store, true, environment);
      if (!context) return;
      const service = await store.getService(context.tenant!._id, request.params.servicePublicId);
      if (!service) return adminNotFound(reply, request.id);
      if (
        !validServiceSettings(request.body) ||
        (request.body.publicly_bookable && service.status !== 'active')
      )
        return safeError(reply, 400, 'validation_failed', request.id);
      if (
        service.publicly_bookable === request.body.publicly_bookable &&
        service.public_display_order === request.body.public_display_order &&
        JSON.stringify(service.public_booking_policy) ===
          JSON.stringify(request.body.public_booking_policy)
      )
        return reply.send(envelope({ ...adminServiceView(service), changed: false }, request.id));
      const result = await store.updateService({
        tenantId: context.tenant!._id,
        publicId: service.public_id,
        userId: context.user._id,
        expectedVersion: request.body.expected_version,
        changes: {
          publicly_bookable: request.body.publicly_bookable,
          public_display_order: request.body.public_display_order,
          public_booking_policy: request.body.public_booking_policy,
        },
      });
      if (result === 'not_found') return adminNotFound(reply, request.id);
      if (result === 'version_conflict') return safeError(reply, 409, result, request.id);
      await store.audit({
        event: 'service_public_booking_updated',
        outcome: 'success',
        actorUserId: context.user._id,
        tenantId: context.tenant!._id,
        requestId: request.id,
        metadata: { service_public_id: service.public_id },
      });
      const updated = await store.getService(context.tenant!._id, service.public_id);
      return reply.send(
        envelope(updated ? { ...adminServiceView(updated), changed: true } : null, request.id),
      );
    },
  );
}

async function resolvePublicTenant(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AdminStore,
) {
  const slug = normalizePublicHostname(request.hostname);
  if (!slug) {
    await safeNotFound(reply, request.id);
    return null;
  }
  const tenant = await store.getPublicTenantBySlug(slug);
  if (!tenant) await safeNotFound(reply, request.id);
  return tenant;
}

export function normalizePublicHostname(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  let label: string | undefined;
  if (normalized.endsWith(PUBLIC_SUFFIX)) label = normalized.slice(0, -PUBLIC_SUFFIX.length);
  else if (normalized.endsWith('.localhost')) label = normalized.slice(0, -'.localhost'.length);
  else if (normalized.endsWith('.example.test'))
    label = normalized.slice(0, -'.example.test'.length);
  if (!label || label.includes('.') || reservedLabels.has(label)) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

async function publicService(store: AdminStore, tenant: TenantDocument, publicId: string) {
  const service = await store.getService(tenant._id, publicId);
  return service?.status === 'active' && service.publicly_bookable ? service : null;
}

function bookingContextView(tenant: TenantDocument) {
  return {
    business: {
      public_id: tenant.public_id,
      name: tenant.public_profile.business_name,
      description: tenant.public_profile.description,
      tagline: tenant.public_profile.tagline,
      logo_url: tenant.public_profile.logo_url,
      primary_color: tenant.public_profile.primary_color,
      website_url: tenant.public_profile.website_url,
      phone: tenant.public_profile.phone_e164,
      email: tenant.public_profile.email_normalized,
    },
    timezone: tenant.default_timezone,
    locale: tenant.locale,
    currency: tenant.currency,
    booking_terms: tenant.public_booking_terms,
  };
}

function publicServiceView(service: ServiceDocument, tenant: TenantDocument) {
  return {
    public_id: service.public_id,
    name: service.name,
    description: service.description,
    delivery_mode: service.delivery_mode,
    duration_minutes: service.duration_minutes,
    base_price_minor: service.base_price_minor,
    booking_fee_minor: service.booking_fee_minor,
    currency: service.currency,
    policy: effectivePolicy(tenant, service),
  };
}

function normalizePublicAppointment(body: PublicAppointmentBody) {
  const firstName = body.customer.first_name.trim();
  const lastName = body.customer.last_name.trim();
  const email = body.customer.email.trim().toLowerCase();
  const phone = normalizeUsPhone(body.customer.mobile_phone);
  const startsAt = new Date(body.starts_at);
  if (
    !firstName ||
    !lastName ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !phone ||
    Number.isNaN(startsAt.valueOf()) ||
    !body.consent.booking_terms_accepted
  )
    return null;
  const address = body.customer.customer_location_address
    ? normalizePublicAddress(body.customer.customer_location_address)
    : null;
  if (body.customer.customer_location_address && !address) return null;
  return {
    service_public_id: body.service_public_id,
    provider_public_id: body.provider_public_id,
    starts_at: startsAt.toISOString(),
    customer: {
      first_name: firstName,
      last_name: lastName,
      email,
      mobile_phone_e164: phone,
      preferred_contact_channel: body.customer.preferred_contact_channel,
      customer_location_address: address,
      appointment_note: body.customer.appointment_note?.trim() || null,
    },
    consent: {
      booking_terms_version: body.consent.booking_terms_version.trim(),
      booking_terms_accepted: true,
    },
  };
}

function normalizeUsPhone(value: string) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`;
  return digits.length === 11 && digits.startsWith('1') ? `+${digits}` : null;
}

function normalizePublicAddress(value: PublicAddressBody) {
  const address = {
    line_1: value.line_1.trim(),
    line_2: value.line_2?.trim() || null,
    city: value.city.trim(),
    region: value.region.trim(),
    postal_code: value.postal_code.trim(),
    country_code: value.country_code.trim().toUpperCase(),
  };
  return address.line_1 &&
    address.city &&
    address.region &&
    address.postal_code &&
    /^[A-Z]{2}$/.test(address.country_code)
    ? address
    : null;
}

async function resolvePublicCustomer(
  store: AdminStore,
  tenantId: ObjectId,
  input: NonNullable<ReturnType<typeof normalizePublicAppointment>>,
  session: ClientSession,
) {
  const emails = await store.findActiveCustomersByEmail(tenantId, input.customer.email, session);
  const phones = await store.findActiveCustomersByPhone(
    tenantId,
    input.customer.mobile_phone_e164,
    session,
  );
  let existing: CustomerDocument | null = null;
  if (emails.length === 1 && phones.length === 1 && emails[0]!._id.equals(phones[0]!._id))
    existing = emails[0]!;
  else if (emails.length === 1 && phones.length === 0 && emails[0]!.mobile_phone_e164 === null)
    existing = emails[0]!;
  else if (phones.length === 1 && emails.length === 0 && phones[0]!.email_normalized === null)
    existing = phones[0]!;
  if (existing) return existing;

  const address: CustomerAddressDocument[] = input.customer.customer_location_address
    ? [
        {
          public_id: randomUUID(),
          label: 'other',
          ...input.customer.customer_location_address,
          is_primary: true,
        },
      ]
    : [];
  return store.createPublicCustomer(
    tenantId,
    {
      first_name: input.customer.first_name,
      last_name: input.customer.last_name,
      preferred_name: null,
      first_name_normalized: input.customer.first_name.toLowerCase(),
      last_name_normalized: input.customer.last_name.toLowerCase(),
      full_name_normalized:
        `${input.customer.first_name} ${input.customer.last_name}`.toLowerCase(),
      email_normalized: input.customer.email,
      mobile_phone_e164: input.customer.mobile_phone_e164,
      mobile_phone_digits: input.customer.mobile_phone_e164.slice(1),
      addresses: address,
      communication_preferences: {
        preferred_channel: input.customer.preferred_contact_channel,
        marketing_email: 'unknown',
        marketing_sms: 'unknown',
      },
      source: 'public_booking',
      external_references: [],
    },
    session,
  );
}

async function validatePublicCandidate(
  store: AdminStore,
  tenant: TenantDocument,
  service: ServiceDocument,
  provider: ProviderDocument,
  assignment: ProviderServiceAssignmentDocument,
  start: Date,
  session: ClientSession,
) {
  const policy = effectivePolicy(tenant, service);
  const now = new Date();
  if (start < new Date(now.valueOf() + policy.minimum_lead_minutes * 60_000))
    throw new PublicBookingError(409, 'slot_no_longer_available');
  const date = localDate(start, tenant.default_timezone);
  if (date > addLocalDays(localDate(now, tenant.default_timezone), policy.maximum_advance_days))
    throw new PublicBookingError(409, 'slot_no_longer_available');
  const schedule = await store.getAvailabilitySchedule(tenant._id, provider._id, session);
  if (!schedule) throw new PublicBookingError(409, 'slot_no_longer_available');
  const exceptions = (
    await store.listAvailabilityExceptions(tenant._id, provider._id, session)
  ).filter((item) => item.status === 'active');
  const cadence = service.slot_cadence_minutes ?? tenant.default_slot_cadence_minutes;
  const slot = generateSlots(
    previewDay(
      date,
      schedule,
      exceptions,
      service.duration_minutes,
      assignment.buffer_before_minutes,
      assignment.buffer_after_minutes,
    ).windows,
    schedule.timezone,
    cadence,
    service.duration_minutes,
    assignment.buffer_before_minutes,
    assignment.buffer_after_minutes,
  ).find((item) => item.starts_at === start.toISOString());
  if (!slot) throw new PublicBookingError(409, 'slot_no_longer_available');
  const blockedStartsAt = new Date(slot.blocked_starts_at);
  const blockedEndsAt = new Date(slot.blocked_ends_at);
  const conflicts = await store.listBlockingAppointments({
    tenantId: tenant._id,
    providerId: provider._id,
    startsBefore: blockedEndsAt,
    endsAfter: blockedStartsAt,
    session,
  });
  if (conflicts.length) throw new PublicBookingError(409, 'slot_no_longer_available');
  return {
    starts_at: start,
    ends_at: new Date(slot.service_ends_at),
    blocked_starts_at: blockedStartsAt,
    blocked_ends_at: blockedEndsAt,
    timezone: schedule.timezone,
    local_start_date: date,
  };
}

function utcDateScopes(providerId: ObjectId, start: Date, end: Date) {
  const scopes = [];
  for (
    let value = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    value <= Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    value += 86_400_000
  )
    scopes.push({ providerId, utcDate: new Date(value).toISOString().slice(0, 10) });
  return scopes;
}

function publicConfirmation(
  item: AppointmentDocument,
  tenant: TenantDocument,
  provider: ProviderDocument | null,
  replayed: boolean,
) {
  return {
    appointment_reference: item.reference,
    status: item.status,
    business: { name: tenant.public_profile.business_name },
    service: {
      name: item.snapshot.service_name,
      duration_minutes: item.snapshot.service_duration_minutes,
    },
    provider: {
      display_name: item.snapshot.provider_display_name,
      photo_url: provider?.photo_url ?? null,
    },
    starts_at: item.starts_at.toISOString(),
    ends_at: item.ends_at.toISOString(),
    local_start: localDateTime(item.starts_at, item.timezone),
    timezone: item.timezone,
    location_mode: item.location.mode,
    replayed,
  };
}

function localDateTime(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = (values.timeZoneName ?? 'GMT+00:00').replace('GMT', '');
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

class PublicBookingError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

function errorName(value: unknown) {
  return value instanceof Error ? value.name : 'UnknownError';
}

function safeMongoErrorDetails(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as { code?: unknown; codeName?: unknown; errorLabels?: unknown };
  return {
    ...(typeof candidate.code === 'number' ? { mongo_error_code: candidate.code } : {}),
    ...(typeof candidate.codeName === 'string'
      ? { mongo_error_code_name: candidate.codeName }
      : {}),
    ...(Array.isArray(candidate.errorLabels) &&
    candidate.errorLabels.every((label) => typeof label === 'string')
      ? { mongo_error_labels: candidate.errorLabels }
      : {}),
  };
}

function effectivePolicy(tenant: TenantDocument, service: ServiceDocument) {
  return {
    minimum_lead_minutes:
      service.public_booking_policy.minimum_lead_minutes ??
      tenant.booking_policy.minimum_lead_minutes ??
      PLATFORM_MINIMUM_LEAD_MINUTES,
    maximum_advance_days:
      service.public_booking_policy.maximum_advance_days ??
      tenant.booking_policy.maximum_advance_days ??
      PLATFORM_MAXIMUM_ADVANCE_DAYS,
  };
}

function publicSchema(operationId: string, querystring?: Record<string, unknown>) {
  return {
    schema: { operationId, tags: ['public-booking'], ...(querystring ? { querystring } : {}) },
    errorHandler(
      error: Error & { validation?: unknown },
      request: FastifyRequest,
      reply: FastifyReply,
    ) {
      if (error.validation)
        return safeError(reply, 400, 'invalid_public_availability_request', request.id);
      request.log.error({
        event: 'public_booking.request_failed',
        outcome: 'failure',
        error_name: error.name,
      });
      return safeError(reply, 500, 'public_request_failed', request.id);
    },
  };
}

function cacheablePublicReply(request: FastifyRequest, reply: FastifyReply, data: unknown) {
  const etag = `"${hash(data)}"`;
  void reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
  void reply.header('ETag', etag);
  if (request.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.send({ data, meta: { request_id: request.id } });
}

function uncacheablePublicReply(
  reply: FastifyReply,
  data: unknown,
  requestId: string,
  nextCursor: string | null = null,
) {
  return reply.header('Cache-Control', 'no-store').send({
    data,
    meta: { request_id: requestId, ...(nextCursor ? { next_cursor: nextCursor } : {}) },
  });
}

function safeNotFound(reply: FastifyReply, requestId: string) {
  return safeError(reply, 404, 'public_business_not_found', requestId);
}

function safeResourceNotFound(reply: FastifyReply, requestId: string) {
  return safeError(reply, 404, 'public_resource_not_found', requestId);
}

function adminNotFound(reply: FastifyReply, requestId: string) {
  return safeError(reply, 404, 'resource_not_found', requestId);
}

function safeError(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply
    .header('Cache-Control', 'no-store')
    .status(status)
    .send({
      error: {
        code,
        message: 'The booking request could not be completed.',
        request_id: requestId,
      },
    });
}

function envelope(data: unknown, requestId: string) {
  return { data, meta: { request_id: requestId } };
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24);
}

function encodeCursor(fingerprint: string, after: string) {
  return Buffer.from(JSON.stringify({ fingerprint, after })).toString('base64url');
}

function decodeCursor(cursor: string | undefined, fingerprint: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      fingerprint?: string;
      after?: string;
    };
    return parsed.fingerprint === fingerprint && typeof parsed.after === 'string'
      ? parsed.after
      : undefined;
  } catch {
    return undefined;
  }
}

function localDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addLocalDays(date: string, count: number) {
  const marker = new Date(`${date}T12:00:00Z`);
  marker.setUTCDate(marker.getUTCDate() + count);
  return marker.toISOString().slice(0, 10);
}

function createPublicRateLimiter() {
  const counters = new Map<string, { count: number; resetsAt: number }>();
  return {
    allow(key: string, maximum: number, windowMilliseconds: number) {
      const now = Date.now();
      const current = counters.get(key);
      if (!current || current.resetsAt <= now) {
        counters.set(key, { count: 1, resetsAt: now + windowMilliseconds });
        if (counters.size > 10_000)
          for (const [itemKey, value] of counters)
            if (value.resetsAt <= now) counters.delete(itemKey);
        return true;
      }
      current.count += 1;
      return current.count <= maximum;
    },
  };
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AdminStore,
  mutation: boolean,
  environment: Environment,
) {
  const context = mutation
    ? await authenticateAdminMutation(request, reply, environment, store)
    : await authenticateAdminRequest(request, store);
  if (!context) {
    if (!reply.sent) await safeError(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!context.tenant || !context.membership) {
    await safeError(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  if (mutation && !managers.has(context.membership.role)) {
    await safeError(reply, 403, 'insufficient_role', request.id);
    return null;
  }
  return context;
}

function adminSettingsView(tenant: TenantDocument) {
  return {
    public_booking_enabled: tenant.public_booking_enabled,
    fallback_hostname: `${tenant.slug}.booknowtech.com`,
    public_profile: tenant.public_profile,
    booking_policy: tenant.booking_policy,
    public_booking_terms: tenant.public_booking_terms,
    version: tenant.version,
  };
}

function normalizePublicSettings(body: PublicSettingsBody, tenant: TenantDocument) {
  if (!body || typeof body !== 'object') return null;
  const profile = body.public_profile;
  if (!profile || typeof profile !== 'object') return null;
  const businessName = profile?.business_name?.trim();
  if (
    !Number.isInteger(body.expected_version) ||
    !businessName ||
    businessName.length > 120 ||
    !validPolicy(body.booking_policy) ||
    !validTerms(body.public_booking_terms) ||
    !validNullable(profile.description, 1000) ||
    !validNullable(profile.tagline, 160) ||
    !validHttps(profile.logo_url) ||
    !validHttps(profile.website_url) ||
    !validPhone(profile.phone_e164) ||
    !validEmail(profile.email_normalized) ||
    (profile.primary_color !== null && !/^#[A-Fa-f0-9]{6}$/.test(profile.primary_color))
  )
    return null;
  if (
    body.public_booking_enabled &&
    (!tenant.default_timezone ||
      !tenant.locale ||
      !tenant.currency ||
      normalizePublicHostname(`${tenant.slug}.booknowtech.com`) !== tenant.slug)
  )
    return null;
  return {
    public_booking_enabled: body.public_booking_enabled,
    public_profile: {
      business_name: businessName,
      description: normalizeNullable(profile.description),
      tagline: normalizeNullable(profile.tagline),
      logo_url: normalizeNullable(profile.logo_url),
      primary_color: accessiblePrimaryColor(profile.primary_color),
      website_url: normalizeNullable(profile.website_url),
      phone_e164: normalizeNullable(profile.phone_e164),
      email_normalized: profile.email_normalized?.trim().toLowerCase() || null,
    },
    booking_policy: body.booking_policy,
    public_booking_terms: {
      version: body.public_booking_terms.version.trim(),
      acknowledgment_label: body.public_booking_terms.acknowledgment_label.trim(),
      terms_url: normalizeNullable(body.public_booking_terms.terms_url),
    },
  };
}

function validTerms(terms: TenantDocument['public_booking_terms']) {
  return (
    Boolean(terms && typeof terms === 'object') &&
    typeof terms.version === 'string' &&
    terms.version.trim().length >= 1 &&
    terms.version.trim().length <= 64 &&
    typeof terms.acknowledgment_label === 'string' &&
    terms.acknowledgment_label.trim().length >= 1 &&
    terms.acknowledgment_label.trim().length <= 300 &&
    validHttps(terms.terms_url)
  );
}

function validServiceSettings(body: ServicePublicSettingsBody) {
  return (
    Boolean(body && typeof body === 'object') &&
    Number.isInteger(body.expected_version) &&
    Number.isInteger(body.public_display_order) &&
    body.public_display_order >= 0 &&
    body.public_display_order <= 100000 &&
    validNullablePolicy(body.public_booking_policy)
  );
}

function validPolicy(policy: TenantDocument['booking_policy']) {
  return (
    Number.isInteger(policy?.minimum_lead_minutes) &&
    policy.minimum_lead_minutes >= 0 &&
    policy.minimum_lead_minutes <= 43200 &&
    Number.isInteger(policy.maximum_advance_days) &&
    policy.maximum_advance_days >= 1 &&
    policy.maximum_advance_days <= 365
  );
}

function validNullablePolicy(policy: ServiceDocument['public_booking_policy']) {
  return (
    Boolean(policy && typeof policy === 'object') &&
    (policy.minimum_lead_minutes === null ||
      (Number.isInteger(policy.minimum_lead_minutes) &&
        policy.minimum_lead_minutes >= 0 &&
        policy.minimum_lead_minutes <= 43200)) &&
    (policy.maximum_advance_days === null ||
      (Number.isInteger(policy.maximum_advance_days) &&
        policy.maximum_advance_days >= 1 &&
        policy.maximum_advance_days <= 365))
  );
}

function validNullable(value: string | null, maximum: number) {
  return value === null || (typeof value === 'string' && value.trim().length <= maximum);
}
function validHttps(value: string | null) {
  if (value === null || value.trim() === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048;
  } catch {
    return false;
  }
}
function validPhone(value: string | null) {
  return value === null || value === '' || /^\+[1-9][0-9]{1,14}$/.test(value);
}
function validEmail(value: string | null) {
  return (
    value === null ||
    value === '' ||
    (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320)
  );
}
function normalizeNullable(value: string | null) {
  return value?.trim() || null;
}

function accessiblePrimaryColor(value: string | null) {
  if (!value) return null;
  const hex = value.toUpperCase();
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  return 1.05 / (luminance + 0.05) >= 4.5 ? hex : null;
}

function utcDatesBetween(start: Date, end: Date) {
  const dates: string[] = [];
  for (
    let value = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    value <= Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    value += 86_400_000
  )
    dates.push(new Date(value).toISOString().slice(0, 10));
  return dates;
}

function adminServiceView(service: ServiceDocument) {
  return {
    public_id: service.public_id,
    internal_code: service.internal_code,
    name: service.name,
    description: service.description,
    delivery_mode: service.delivery_mode,
    duration_minutes: service.duration_minutes,
    base_price_minor: service.base_price_minor,
    booking_fee_minor: service.booking_fee_minor,
    slot_cadence_minutes: service.slot_cadence_minutes,
    currency: service.currency,
    status: service.status,
    publicly_bookable: service.publicly_bookable,
    public_display_order: service.public_display_order,
    public_booking_policy: service.public_booking_policy,
    version: service.version,
  };
}
