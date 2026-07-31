import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminStore, ServiceDocument, TenantDocument } from '../admin/store.js';
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
}

interface ServicePublicSettingsBody {
  expected_version: number;
  publicly_bookable: boolean;
  public_display_order: number;
  public_booking_policy: ServiceDocument['public_booking_policy'];
}

export function registerPublicBookingRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  const limiter = createPublicRateLimiter();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/public/')) return;
    const hostname = normalizePublicHostname(request.hostname) ?? 'invalid';
    const route = request.routeOptions.url ?? request.url.split('?')[0]!;
    const maximum = route.endsWith('/available-starts') ? 30 : 120;
    if (!limiter.allow(`${request.ip}:${hostname}:${route}`, maximum)) {
      void reply.header('Retry-After', '60');
      return safeError(reply, 429, 'public_rate_limit_exceeded', request.id);
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

  registerAdministrativeConfiguration(app, environment, store);
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
    allow(key: string, maximum: number) {
      const now = Date.now();
      const current = counters.get(key);
      if (!current || current.resetsAt <= now) {
        counters.set(key, { count: 1, resetsAt: now + 60_000 });
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
  };
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
