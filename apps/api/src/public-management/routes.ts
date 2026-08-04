import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ClientSession } from 'mongodb';
import {
  derivePublicAppointmentCredential,
  hashPublicAppointmentCredential,
  verifyPublicAppointmentCredential,
} from '@booknowtech/shared';

import type {
  AdminStore,
  AppointmentDocument,
  AppointmentPublicAccessTokenDocument,
  ProviderDocument,
  ServiceDocument,
  TenantDocument,
} from '../admin/store.js';
import { dateRange, generateSlots, localToUtc, previewDay } from '../availability/routes.js';
import type { Environment } from '../config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerPublicAppointmentManagementRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get<{ Params: { tokenPublicId: string } }>(
    '/api/v1/public/appointments/manage/:tokenPublicId',
    async (request, reply) => {
      const resolved = await resolve(request, reply, environment, store);
      if (!resolved) return;
      return noStore(
        reply,
        view(resolved.tenant, resolved.service, resolved.appointment, resolved.provider),
        request.id,
      );
    },
  );

  app.get<{
    Params: { tokenPublicId: string };
    Querystring: { start_date: string; end_date: string };
  }>(
    '/api/v1/public/appointments/manage/:tokenPublicId/available-starts',
    async (request, reply) => {
      const resolved = await resolve(request, reply, environment, store);
      if (!resolved) return;
      if (!canAct(resolved.appointment, cutoff(resolved.tenant, resolved.service, 'reschedule')))
        return safe(reply, 409, 'action_unavailable', request.id);
      const dates = dateRange(request.query.start_date, request.query.end_date);
      if (!dates || dates.length > 7) return safe(reply, 400, 'invalid_date_range', request.id);
      const maximumDays =
        resolved.service.public_booking_policy.maximum_advance_days ??
        resolved.tenant.booking_policy.maximum_advance_days ??
        90;
      const today = localDate(new Date(), resolved.tenant.default_timezone);
      if (request.query.start_date < today || request.query.end_date > addDays(today, maximumDays))
        return safe(reply, 400, 'invalid_date_range', request.id);
      const items = await replacementStarts(store, resolved, dates);
      return noStore(reply, { timezone: resolved.appointment.timezone, items }, request.id);
    },
  );

  app.post<{
    Params: { tokenPublicId: string };
    Body: { expected_version: number; starts_at: string };
  }>('/api/v1/public/appointments/manage/:tokenPublicId/reschedule', async (request, reply) =>
    mutate(request, reply, environment, store, 'reschedule'),
  );
  app.post<{
    Params: { tokenPublicId: string };
    Body: { expected_version: number; confirmation: string };
  }>('/api/v1/public/appointments/manage/:tokenPublicId/cancel', async (request, reply) =>
    mutate(request, reply, environment, store, 'cancel'),
  );
}

type Resolved = {
  tenant: TenantDocument;
  token: AppointmentPublicAccessTokenDocument;
  appointment: AppointmentDocument;
  service: ServiceDocument;
  provider: ProviderDocument;
};

async function resolve(
  request: FastifyRequest<{ Params: { tokenPublicId: string } }>,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
  allowConsumed = false,
): Promise<Resolved | null> {
  const slug = hostnameSlug(request.hostname);
  const credential = appointmentCredential(request.headers.authorization);
  if (!slug || !credential || !UUID.test(request.params.tokenPublicId))
    return unavailable(reply, request.id);
  const tenant = await store.getActiveTenantBySlug(slug);
  if (!tenant?.appointment_self_service.enabled) return unavailable(reply, request.id);
  const token = await store.getAppointmentAccessToken(tenant._id, request.params.tokenPublicId);
  if (!token || (!allowConsumed && token.status !== 'active') || token.expires_at <= new Date())
    return unavailable(reply, request.id);
  const expected = derivePublicAppointmentCredential(environment.PUBLIC_APPOINTMENT_TOKEN_SECRET, {
    version: 1,
    tokenPublicId: token.public_id,
    appointmentPublicId: token.appointment_public_id,
    generation: token.generation,
    purpose: 'appointment_management',
  });
  if (
    !verifyPublicAppointmentCredential(credential, token.token_hash) ||
    !verifyPublicAppointmentCredential(credential, hashPublicAppointmentCredential(expected))
  )
    return unavailable(reply, request.id);
  const appointment = await store.getAppointment(tenant._id, token.appointment_public_id);
  if (!appointment) return unavailable(reply, request.id);
  const service = await store.getServiceById(tenant._id, appointment.service_id);
  const provider = await store.getProviderById(tenant._id, appointment.provider_id);
  if (!service || !provider) return unavailable(reply, request.id);
  return { tenant, token, appointment, service, provider };
}

async function mutate(
  request: FastifyRequest<{
    Params: { tokenPublicId: string };
    Body: { expected_version: number; starts_at?: string; confirmation?: string };
  }>,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
  kind: 'reschedule' | 'cancel',
) {
  const idempotency = request.headers['idempotency-key'];
  if (typeof idempotency !== 'string' || !UUID.test(idempotency))
    return safe(reply, 400, 'invalid_idempotency_key', request.id);
  const resolved = await resolve(request, reply, environment, store, true);
  if (!resolved) return;
  const fingerprint = sha(JSON.stringify({ kind, body: request.body }));
  const keyHash = sha(idempotency);
  if (resolved.token.status === 'consumed') {
    const prior = resolved.token.mutation;
    if (!prior || prior.idempotency_key_hash !== keyHash) return unavailable(reply, request.id);
    if (prior.request_fingerprint !== fingerprint)
      return safe(reply, 409, 'idempotency_conflict', request.id);
    const current = await store.getAppointment(resolved.tenant._id, resolved.appointment.public_id);
    return noStore(
      reply,
      { ...view(resolved.tenant, resolved.service, current!, resolved.provider), replayed: true },
      request.id,
    );
  }
  if (
    resolved.appointment.status !== 'scheduled' ||
    resolved.appointment.version !== request.body.expected_version
  )
    return safe(reply, 409, 'version_conflict', request.id);
  const minutes = cutoff(resolved.tenant, resolved.service, kind);
  if (!canAct(resolved.appointment, minutes))
    return safe(reply, 409, 'action_unavailable', request.id);
  if (kind === 'cancel' && request.body.confirmation !== 'CANCEL')
    return safe(reply, 400, 'confirmation_required', request.id);
  let target: Awaited<ReturnType<typeof candidate>> | null = null;
  if (kind === 'reschedule') {
    if (typeof request.body.starts_at !== 'string')
      return safe(reply, 400, 'invalid_start', request.id);
    target = await candidate(store, resolved, request.body.starts_at);
    if (!target) return safe(reply, 409, 'start_unavailable', request.id);
  }
  const scopes = utcScopes(resolved.appointment, target);
  try {
    const result = await store.withAppointmentScheduleLocks(
      resolved.tenant._id,
      scopes,
      async (session) => {
        const currentToken = await store.getAppointmentAccessToken(
          resolved.tenant._id,
          resolved.token.public_id,
          session,
        );
        const current = await store.getAppointment(
          resolved.tenant._id,
          resolved.appointment.public_id,
          session,
        );
        const currentTenant = await store.getActiveTenantBySlug(resolved.tenant.slug, session);
        if (
          !currentTenant?.appointment_self_service.enabled ||
          !currentToken ||
          currentToken.status !== 'active' ||
          currentToken.expires_at <= new Date() ||
          !current ||
          current.version !== request.body.expected_version ||
          current.status !== 'scheduled' ||
          !canAct(current, minutes)
        )
          throw new Error('version_conflict');
        let replacement: AppointmentPublicAccessTokenDocument | null = null;
        const replacementPublicId = kind === 'reschedule' ? randomUUID() : null;
        if (kind === 'reschedule') {
          const conflicts = await store.listBlockingAppointments({
            tenantId: resolved.tenant._id,
            providerId: current.provider_id,
            startsBefore: target!.blocked_ends_at,
            endsAfter: target!.blocked_starts_at,
            excludeAppointmentId: current._id,
            session,
          });
          if (conflicts.length) throw new Error('start_unavailable');
          const updated = await store.updateAppointmentSchedule({
            appointment: current,
            tenantId: resolved.tenant._id,
            userId: null,
            expectedVersion: current.version,
            startsAt: target!.starts_at,
            endsAt: target!.ends_at,
            blockedStartsAt: target!.blocked_starts_at,
            blockedEndsAt: target!.blocked_ends_at,
            localStartDate: target!.local_start_date,
            session,
          });
          if (updated !== 'updated') throw new Error('version_conflict');
          const next = (await store.getAppointment(
            resolved.tenant._id,
            current.public_id,
            session,
          ))!;
          await store.consumeAppointmentAccessToken({
            token: currentToken,
            mutation: {
              type: kind,
              idempotency_key_hash: keyHash,
              request_fingerprint: fingerprint,
              result_appointment_version: next.version,
              replacement_token_public_id: replacementPublicId,
            },
            session,
          });
          replacement = await store.insertAppointmentAccessToken({
            tenant: resolved.tenant,
            appointment: next,
            generation: currentToken.generation + 1,
            tokenSecret: environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
            session,
            publicId: replacementPublicId!,
          });
          await enqueue(
            store,
            resolved.tenant,
            next,
            'appointment_rescheduled',
            request.id,
            session,
            replacement,
            environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
          );
        } else {
          const updated = await store.transitionAppointment({
            appointment: current,
            tenantId: resolved.tenant._id,
            userId: null,
            expectedVersion: current.version,
            status: 'cancelled',
            reason: 'customer_request',
            detail: null,
            session,
          });
          if (updated !== 'updated') throw new Error('version_conflict');
          const next = (await store.getAppointment(
            resolved.tenant._id,
            current.public_id,
            session,
          ))!;
          await store.consumeAppointmentAccessToken({
            token: currentToken,
            mutation: {
              type: kind,
              idempotency_key_hash: keyHash,
              request_fingerprint: fingerprint,
              result_appointment_version: next.version,
              replacement_token_public_id: null,
            },
            session,
          });
          await enqueue(
            store,
            resolved.tenant,
            next,
            'appointment_cancelled',
            request.id,
            session,
            null,
            environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
          );
        }
        const nextAppointment = (await store.getAppointment(
          resolved.tenant._id,
          current.public_id,
          session,
        ))!;
        await store.audit({
          event: kind === 'reschedule' ? 'appointment_rescheduled' : 'appointment_cancelled',
          outcome: 'success',
          actorUserId: null,
          tenantId: resolved.tenant._id,
          requestId: request.id,
          metadata: { source: 'public_self_service', appointment_reference: current.reference },
          session,
        });
        return { appointment: nextAppointment, replacement };
      },
    );
    const credential = result.replacement
      ? derivePublicAppointmentCredential(environment.PUBLIC_APPOINTMENT_TOKEN_SECRET, {
          version: 1,
          tokenPublicId: result.replacement.public_id,
          appointmentPublicId: result.replacement.appointment_public_id,
          generation: result.replacement.generation,
          purpose: 'appointment_management',
        })
      : null;
    return noStore(
      reply,
      {
        ...view(resolved.tenant, resolved.service, result.appointment, resolved.provider),
        replacement: result.replacement
          ? { token_public_id: result.replacement.public_id, credential }
          : null,
        replayed: false,
      },
      request.id,
    );
  } catch {
    const replay = await store.getAppointmentAccessToken(
      resolved.tenant._id,
      resolved.token.public_id,
    );
    if (replay?.status === 'consumed' && replay.mutation?.idempotency_key_hash === keyHash) {
      if (replay.mutation.request_fingerprint !== fingerprint)
        return safe(reply, 409, 'idempotency_conflict', request.id);
      const current = await store.getAppointment(
        resolved.tenant._id,
        resolved.appointment.public_id,
      );
      return noStore(
        reply,
        { ...view(resolved.tenant, resolved.service, current!, resolved.provider), replayed: true },
        request.id,
      );
    }
    return safe(reply, 409, 'version_conflict', request.id);
  }
}

async function enqueue(
  store: AdminStore,
  tenant: TenantDocument,
  appointment: AppointmentDocument,
  type: 'appointment_rescheduled' | 'appointment_cancelled',
  requestId: string,
  session: ClientSession,
  token: AppointmentPublicAccessTokenDocument | null,
  secret: string,
) {
  const [customer, provider] = await Promise.all([
    store.getCustomerById(tenant._id, appointment.customer_id, session),
    store.getProviderById(tenant._id, appointment.provider_id, session),
  ]);
  if (customer && provider)
    await store.enqueueAppointmentEmail({
      tenant,
      appointment,
      customer,
      provider,
      type,
      requestId,
      session,
      appointmentAccess: token
        ? { token_public_id: token.public_id, generation: token.generation }
        : null,
      tokenSecret: secret,
    });
}

async function replacementStarts(store: AdminStore, resolved: Resolved, dates: string[]) {
  const provider = await store.getProviderById(
    resolved.tenant._id,
    resolved.appointment.provider_id,
  );
  const assignment = await store.findAppointmentAssignment(
    resolved.tenant._id,
    resolved.appointment.provider_id,
    resolved.appointment.service_id,
  );
  const schedule = await store.getAvailabilitySchedule(
    resolved.tenant._id,
    resolved.appointment.provider_id,
  );
  if (
    resolved.service.status !== 'active' ||
    !provider ||
    provider.status !== 'active' ||
    !assignment ||
    assignment.status !== 'active' ||
    !schedule
  )
    return [];
  const exceptions = (
    await store.listAvailabilityExceptions(resolved.tenant._id, provider._id)
  ).filter((item) => item.status === 'active');
  const items: Array<{
    starts_at: string;
    ends_at: string;
    local_start: string;
    timezone: string;
  }> = [];
  for (const date of dates) {
    const start = localToUtc(date, 0, schedule.timezone, 'earlier');
    const end = localToUtc(addDays(date, 1), 0, schedule.timezone, 'later');
    const blocking = await store.listBlockingAppointments({
      tenantId: resolved.tenant._id,
      providerId: provider._id,
      startsBefore: end,
      endsAfter: start,
      excludeAppointmentId: resolved.appointment._id,
    });
    const slots = generateSlots(
      previewDay(
        date,
        schedule,
        exceptions,
        resolved.appointment.snapshot.service_duration_minutes,
        resolved.appointment.snapshot.buffer_before_minutes,
        resolved.appointment.snapshot.buffer_after_minutes,
      ).windows,
      schedule.timezone,
      resolved.appointment.snapshot.slot_cadence_minutes,
      resolved.appointment.snapshot.service_duration_minutes,
      resolved.appointment.snapshot.buffer_before_minutes,
      resolved.appointment.snapshot.buffer_after_minutes,
    ).filter(
      (slot) =>
        !blocking.some(
          (item) =>
            item.blocked_starts_at < new Date(slot.blocked_ends_at) &&
            item.blocked_ends_at > new Date(slot.blocked_starts_at),
        ),
    );
    const lead =
      resolved.service.public_booking_policy.minimum_lead_minutes ??
      resolved.tenant.booking_policy.minimum_lead_minutes ??
      120;
    const minimum = Date.now() + lead * 60000;
    items.push(
      ...slots
        .filter((slot) => new Date(slot.starts_at).valueOf() >= minimum)
        .map((slot) => ({
          starts_at: slot.starts_at,
          ends_at: slot.service_ends_at,
          local_start: slot.local_start,
          timezone: schedule.timezone,
        })),
    );
  }
  return items;
}

async function candidate(store: AdminStore, resolved: Resolved, startsAt: string) {
  const date = localDate(new Date(startsAt), resolved.appointment.timezone);
  const match = (await replacementStarts(store, resolved, [date])).find(
    (item) => item.starts_at === new Date(startsAt).toISOString(),
  );
  if (!match) return null;
  const start = new Date(match.starts_at);
  const end = new Date(match.ends_at);
  return {
    starts_at: start,
    ends_at: end,
    blocked_starts_at: new Date(
      start.valueOf() - resolved.appointment.snapshot.buffer_before_minutes * 60000,
    ),
    blocked_ends_at: new Date(
      end.valueOf() + resolved.appointment.snapshot.buffer_after_minutes * 60000,
    ),
    local_start_date: date,
  };
}

function view(
  tenant: TenantDocument,
  service: ServiceDocument,
  appointment: AppointmentDocument,
  provider: ProviderDocument,
) {
  const cancel = cutoff(tenant, service, 'cancel');
  const reschedule = cutoff(tenant, service, 'reschedule');
  return {
    business: {
      name: tenant.public_profile.business_name,
      logo_url: tenant.public_profile.logo_url,
      primary_color: tenant.public_profile.primary_color,
      phone: tenant.public_profile.phone_e164,
      email: tenant.public_profile.email_normalized,
      website: tenant.public_profile.website_url,
    },
    appointment: {
      reference: appointment.reference,
      status: appointment.status,
      service_name: appointment.snapshot.service_name,
      duration_minutes: appointment.snapshot.service_duration_minutes,
      provider_name: appointment.snapshot.provider_display_name,
      provider_photo_url: provider.photo_url,
      starts_at: appointment.starts_at.toISOString(),
      ends_at: appointment.ends_at.toISOString(),
      local_start: localInstant(appointment.starts_at, appointment.timezone),
      timezone: appointment.timezone,
      version: appointment.version,
    },
    actions: {
      can_reschedule: canAct(appointment, reschedule),
      can_cancel: canAct(appointment, cancel),
      reschedule_until: new Date(
        appointment.starts_at.valueOf() - reschedule * 60000,
      ).toISOString(),
      cancel_until: new Date(appointment.starts_at.valueOf() - cancel * 60000).toISOString(),
    },
  };
}
function cutoff(tenant: TenantDocument, service: ServiceDocument, kind: 'reschedule' | 'cancel') {
  return kind === 'reschedule'
    ? (service.public_self_service_policy.reschedule_cutoff_minutes ??
        tenant.appointment_self_service.reschedule_cutoff_minutes ??
        1440)
    : (service.public_self_service_policy.cancellation_cutoff_minutes ??
        tenant.appointment_self_service.cancellation_cutoff_minutes ??
        1440);
}
function canAct(appointment: AppointmentDocument, minutes: number) {
  return (
    appointment.status === 'scheduled' &&
    Date.now() < appointment.starts_at.valueOf() - minutes * 60000
  );
}
function appointmentCredential(value: string | undefined) {
  const match = /^AppointmentToken ([A-Za-z0-9_-]+)$/.exec(value ?? '');
  return match?.[1] ?? null;
}
function hostnameSlug(hostname: string) {
  const host = hostname.toLowerCase().split(':')[0]!;
  const productionSuffix = '.booknowtech.com';
  if (host.endsWith(productionSuffix)) return host.slice(0, -productionSuffix.length);
  if (host.endsWith('.example.test')) return host.split('.')[0] ?? null;
  if (host.endsWith('.localhost')) return host.split('.')[0] ?? null;
  return null;
}
function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function safe(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply
    .header('Cache-Control', 'no-store')
    .status(status)
    .send({
      error: {
        code,
        message: 'The appointment request could not be completed.',
        request_id: requestId,
      },
    });
}
function unavailable(reply: FastifyReply, requestId: string): null {
  void safe(reply, 404, 'appointment_link_unavailable', requestId);
  return null;
}
function noStore(reply: FastifyReply, data: unknown, requestId: string) {
  return reply.header('Cache-Control', 'no-store').send({ data, meta: { request_id: requestId } });
}
function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function localDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function localInstant(date: Date, timezone: string) {
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
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = values.timeZoneName === 'GMT' ? 'Z' : values.timeZoneName?.replace('GMT', '');
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}
function utcScopes(
  appointment: AppointmentDocument,
  target: Awaited<ReturnType<typeof candidate>> | null,
) {
  const dates = new Set<string>();
  for (const instant of [
    appointment.blocked_starts_at,
    appointment.blocked_ends_at,
    target?.blocked_starts_at,
    target?.blocked_ends_at,
  ])
    if (instant) dates.add(instant.toISOString().slice(0, 10));
  return [...dates].map((utcDate) => ({ providerId: appointment.provider_id, utcDate }));
}
