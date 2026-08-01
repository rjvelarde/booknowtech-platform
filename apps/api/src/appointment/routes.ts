import type { ClientSession, ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  APPOINTMENT_STATUSES,
  type AdminStore,
  type AppointmentDocument,
  type AppointmentStatus,
  type CustomerAddressDocument,
  type VerifiedAdminContext,
} from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import { generateSlots, localToUtc, previewDay } from '../availability/routes.js';
import type { Environment } from '../config.js';

const appointmentRoles = new Set(['tenant_owner', 'tenant_admin', 'front_desk']);
const overrideRoles = new Set(['tenant_owner', 'tenant_admin']);
const cancellationReasons = [
  'customer_request',
  'provider_unavailable',
  'business_closed',
  'duplicate',
  'other',
] as const;

interface CreateBody {
  customer_public_id: string;
  provider_public_id: string;
  service_public_id: string;
  starts_at: string;
  customer_address_public_id?: string | null;
}
interface RescheduleBody {
  expected_version: number;
  starts_at: string;
}
interface LifecycleBody {
  expected_version: number;
  early_override?: boolean;
}
interface CancelBody {
  expected_version: number;
  reason?: AppointmentDocument['cancellation_reason'];
  detail?: string | null;
}

class AppointmentRuleError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

const expectedVersionSchema = { type: 'integer', minimum: 1 } as const;

export function registerAppointmentRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get<{
    Querystring: {
      view?: 'today' | 'upcoming' | 'past';
      start_date?: string;
      end_date?: string;
      status?: string;
      provider_public_id?: string;
      service_public_id?: string;
      customer_query?: string;
      reference?: string;
      limit?: number;
      cursor?: string;
    };
  }>(
    '/api/v1/admin/appointments',
    {
      schema: {
        operationId: 'listAppointments',
        tags: ['appointments'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['today', 'upcoming', 'past'], default: 'upcoming' },
            start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            status: { type: 'string', maxLength: 100 },
            provider_public_id: { type: 'string', minLength: 1 },
            service_public_id: { type: 'string', minLength: 1 },
            customer_query: { type: 'string', minLength: 2, maxLength: 100 },
            reference: { type: 'string', minLength: 2, maxLength: 32 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            cursor: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireAppointmentRole(request, reply, store);
      if (!context) return;
      const tenant = context.tenant!;
      const statuses = parseStatuses(request.query.status);
      if (request.query.status && !statuses)
        return sendError(reply, 400, 'invalid_appointment_request', request.id);
      let providerId: ObjectId | undefined;
      if (request.query.provider_public_id) {
        const provider = await store.getProvider(tenant._id, request.query.provider_public_id);
        if (!provider) return sendError(reply, 404, 'provider_not_found', request.id);
        providerId = provider._id;
      }
      let serviceId: ObjectId | undefined;
      if (request.query.service_public_id) {
        const service = await store.getService(tenant._id, request.query.service_public_id);
        if (!service) return sendError(reply, 404, 'service_not_found', request.id);
        serviceId = service._id;
      }
      let customerIds: ObjectId[] | undefined;
      if (request.query.customer_query) {
        const normalized = request.query.customer_query.trim().toLowerCase();
        const digits = normalized.replace(/\D/g, '');
        customerIds = (
          await store.listCustomers({
            tenantId: tenant._id,
            textPrefix: normalized,
            ...(digits ? { phonePrefix: digits } : {}),
            limit: 100,
          })
        ).map((item) => item._id);
        if (!customerIds.length)
          return reply.send(envelope({ items: [], next_cursor: null }, request.id));
      }
      const range = appointmentRange(request.query, tenant.default_timezone);
      if (!range) return sendError(reply, 400, 'invalid_date_range', request.id);
      const direction = request.query.view === 'past' ? 'descending' : 'ascending';
      const after = request.query.cursor
        ? decodeAppointmentCursor(request.query.cursor, direction, request.query)
        : undefined;
      if (request.query.cursor && !after)
        return sendError(reply, 400, 'invalid_cursor', request.id);
      const limit = request.query.limit ?? 25;
      const documents = await store.listAppointments({
        tenantId: tenant._id,
        ...(statuses ? { statuses } : {}),
        ...(providerId ? { providerId } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(customerIds ? { customerIds } : {}),
        ...(request.query.reference
          ? { referencePrefix: request.query.reference.trim().toUpperCase() }
          : {}),
        ...range,
        ...(after ? { after } : {}),
        direction,
        limit: limit + 1,
      });
      const items = documents.slice(0, limit);
      return reply.send(
        envelope(
          {
            items: items.map(appointmentSummaryView),
            next_cursor:
              documents.length > limit
                ? encodeAppointmentCursor(items.at(-1)!, direction, request.query)
                : null,
          },
          request.id,
        ),
      );
    },
  );

  app.get<{ Params: { appointmentPublicId: string } }>(
    '/api/v1/admin/appointments/:appointmentPublicId',
    { schema: { operationId: 'getAppointment', tags: ['appointments'] } },
    async (request, reply) => {
      const context = await requireAppointmentRole(request, reply, store);
      if (!context) return;
      const item = await store.getAppointment(
        context.tenant!._id,
        request.params.appointmentPublicId,
      );
      if (!item) return sendError(reply, 404, 'appointment_not_found', request.id);
      return reply.send(
        envelope(await appointmentDetailView(store, context.tenant!._id, item), request.id),
      );
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/v1/admin/appointments',
    {
      schema: {
        operationId: 'createAppointment',
        tags: ['appointments'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_public_id', 'provider_public_id', 'service_public_id', 'starts_at'],
          properties: {
            customer_public_id: { type: 'string', minLength: 1 },
            provider_public_id: { type: 'string', minLength: 1 },
            service_public_id: { type: 'string', minLength: 1 },
            starts_at: { type: 'string', format: 'date-time' },
            customer_address_public_id: {
              anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireAppointmentMutation(request, reply, environment, store);
      if (!context) return;
      const start = parseInstant(request.body.starts_at);
      if (!start) return sendError(reply, 400, 'invalid_appointment_request', request.id);
      const tenantId = context.tenant!._id;
      const initialProvider = await store.getProvider(tenantId, request.body.provider_public_id);
      if (!initialProvider) return sendError(reply, 404, 'provider_not_found', request.id);
      const initialService = await store.getService(tenantId, request.body.service_public_id);
      if (!initialService) return sendError(reply, 404, 'service_not_found', request.id);
      const initialAssignment = await store.findAppointmentAssignment(
        tenantId,
        initialProvider._id,
        initialService._id,
      );
      if (!initialAssignment) return sendError(reply, 404, 'assignment_not_found', request.id);
      const preliminaryBlockedStart = new Date(
        start.valueOf() - initialAssignment.buffer_before_minutes * 60_000,
      );
      const preliminaryBlockedEnd = new Date(
        start.valueOf() +
          (initialService.duration_minutes + initialAssignment.buffer_after_minutes) * 60_000,
      );
      try {
        const item = await store.withAppointmentScheduleLocks(
          tenantId,
          utcDateScopes(initialProvider._id, preliminaryBlockedStart, preliminaryBlockedEnd),
          async (session) => {
            const subject = await loadSubject(
              store,
              tenantId,
              request.body.customer_public_id,
              request.body.provider_public_id,
              request.body.service_public_id,
              session,
            );
            const candidate = await validateCandidate({
              store,
              tenantId,
              subject,
              start,
              session,
              tenantDefaultCadence: context.tenant!.default_slot_cadence_minutes,
            });
            const address = selectAddress(
              subject.service.delivery_mode,
              subject.customer.addresses,
              request.body.customer_address_public_id,
            );
            const now = new Date();
            const appointment = await store.insertAppointment(
              {
                tenant_id: tenantId,
                customer_id: subject.customer._id,
                provider_id: subject.provider._id,
                service_id: subject.service._id,
                provider_service_assignment_id: subject.assignment._id,
                ...candidate,
                snapshot: {
                  customer_display_name: customerDisplayName(subject.customer),
                  provider_display_name: subject.provider.display_name,
                  service_name: subject.service.name,
                  service_duration_minutes: subject.service.duration_minutes,
                  slot_cadence_minutes:
                    subject.service.slot_cadence_minutes ??
                    context.tenant!.default_slot_cadence_minutes,
                  buffer_before_minutes: subject.assignment.buffer_before_minutes,
                  buffer_after_minutes: subject.assignment.buffer_after_minutes,
                  delivery_mode: subject.service.delivery_mode,
                  base_price_minor: subject.service.base_price_minor,
                  booking_fee_minor: subject.service.booking_fee_minor,
                  currency: subject.service.currency,
                  customer_note: null,
                },
                location: { mode: subject.service.delivery_mode, customer_address: address },
                status: 'scheduled',
                source: 'business_hub',
                public_submission: null,
                booking_terms: null,
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
                created_by: context.user._id,
                updated_by: context.user._id,
              },
              session,
            );
            await store.enqueueAppointmentEmail({
              tenant: context.tenant!,
              appointment,
              customer: subject.customer,
              provider: subject.provider,
              type: 'appointment_confirmation',
              requestId: request.id,
              session,
            });
            return appointment;
          },
        );
        await appointmentAudit(store, context, request.id, 'appointment_created', item, {
          prior_version: null,
          new_version: String(item.version),
          prior_status: null,
          new_status: item.status,
        });
        return reply
          .status(201)
          .send(envelope(await appointmentDetailView(store, tenantId, item), request.id));
      } catch (reason) {
        return handleRuleError(reason, reply, request.id);
      }
    },
  );

  app.post<{ Params: { appointmentPublicId: string }; Body: RescheduleBody }>(
    '/api/v1/admin/appointments/:appointmentPublicId/reschedule',
    {
      schema: {
        operationId: 'rescheduleAppointment',
        tags: ['appointments'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version', 'starts_at'],
          properties: {
            expected_version: expectedVersionSchema,
            starts_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireAppointmentMutation(request, reply, environment, store);
      if (!context) return;
      const tenantId = context.tenant!._id;
      const before = await store.getAppointment(tenantId, request.params.appointmentPublicId);
      if (!before) return sendError(reply, 404, 'appointment_not_found', request.id);
      if (before.status !== 'scheduled')
        return sendError(reply, 409, 'invalid_appointment_transition', request.id);
      const start = parseInstant(request.body.starts_at);
      if (!start) return sendError(reply, 400, 'invalid_appointment_request', request.id);
      const newBlockedStart = new Date(
        start.valueOf() - before.snapshot.buffer_before_minutes * 60_000,
      );
      const newBlockedEnd = new Date(
        start.valueOf() +
          (before.snapshot.service_duration_minutes + before.snapshot.buffer_after_minutes) *
            60_000,
      );
      const scopes = [
        ...utcDateScopes(before.provider_id, before.blocked_starts_at, before.blocked_ends_at),
        ...utcDateScopes(before.provider_id, newBlockedStart, newBlockedEnd),
      ];
      try {
        const updated = await store.withAppointmentScheduleLocks(
          tenantId,
          scopes,
          async (session) => {
            const current = await store.getAppointment(
              tenantId,
              request.params.appointmentPublicId,
              session,
            );
            if (!current) throw new AppointmentRuleError(404, 'appointment_not_found');
            if (current.status !== 'scheduled')
              throw new AppointmentRuleError(409, 'invalid_appointment_transition');
            if (current.version !== request.body.expected_version)
              throw new AppointmentRuleError(409, 'version_conflict');
            const subject = await loadSubjectByAppointment(store, tenantId, current, session);
            const candidate = await validateCandidate({
              store,
              tenantId,
              subject,
              start,
              session,
              tenantDefaultCadence: context.tenant!.default_slot_cadence_minutes,
              terms: {
                duration: current.snapshot.service_duration_minutes,
                before: current.snapshot.buffer_before_minutes,
                after: current.snapshot.buffer_after_minutes,
                timezone: current.timezone,
                cadence: current.snapshot.slot_cadence_minutes,
              },
              excludeAppointmentId: current._id,
            });
            const result = await store.updateAppointmentSchedule({
              appointment: current,
              tenantId,
              userId: context.user._id,
              expectedVersion: request.body.expected_version,
              startsAt: candidate.starts_at,
              endsAt: candidate.ends_at,
              blockedStartsAt: candidate.blocked_starts_at,
              blockedEndsAt: candidate.blocked_ends_at,
              localStartDate: candidate.local_start_date,
              session,
            });
            if (result !== 'updated') throw new AppointmentRuleError(409, 'version_conflict');
            const updated = (await store.getAppointment(tenantId, current.public_id, session))!;
            await enqueueLifecycleEmail(
              store,
              context.tenant!,
              updated,
              'appointment_rescheduled',
              request.id,
              session,
            );
            return updated;
          },
        );
        await appointmentAudit(store, context, request.id, 'appointment_rescheduled', updated, {
          prior_version: String(before.version),
          new_version: String(updated.version),
          prior_status: before.status,
          new_status: updated.status,
          prior_starts_at: before.starts_at.toISOString(),
          new_starts_at: updated.starts_at.toISOString(),
          prior_blocked_starts_at: before.blocked_starts_at.toISOString(),
          new_blocked_starts_at: updated.blocked_starts_at.toISOString(),
          prior_blocked_ends_at: before.blocked_ends_at.toISOString(),
          new_blocked_ends_at: updated.blocked_ends_at.toISOString(),
        });
        return reply.send(
          envelope(
            { ...(await appointmentDetailView(store, tenantId, updated)), changed: true },
            request.id,
          ),
        );
      } catch (reason) {
        return handleRuleError(reason, reply, request.id);
      }
    },
  );

  app.post<{ Params: { appointmentPublicId: string }; Body: CancelBody }>(
    '/api/v1/admin/appointments/:appointmentPublicId/cancel',
    { schema: { operationId: 'cancelAppointment', tags: ['appointments'], body: cancelSchema } },
    async (request, reply) =>
      transitionRoute(request, reply, environment, store, 'cancelled', request.body),
  );
  for (const [path, status, event] of [
    ['complete', 'completed', 'appointment_completed'],
    ['no-show', 'no_show', 'appointment_no_show'],
  ] as const)
    app.post<{
      Params: { appointmentPublicId: string };
      Body: LifecycleBody;
    }>(
      `/api/v1/admin/appointments/:appointmentPublicId/${path}`,
      {
        schema: {
          operationId: `${path === 'complete' ? 'complete' : 'markNoShow'}Appointment`,
          tags: ['appointments'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expected_version'],
            properties: {
              expected_version: expectedVersionSchema,
              early_override: { type: 'boolean', default: false },
            },
          },
        },
      },
      async (request, reply) =>
        transitionRoute(request, reply, environment, store, status, request.body, event),
    );
}

async function transitionRoute(
  request: FastifyRequest<{
    Params: { appointmentPublicId: string };
    Body: LifecycleBody | CancelBody;
  }>,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
  status: Exclude<AppointmentStatus, 'scheduled'>,
  body: LifecycleBody | CancelBody,
  event = 'appointment_cancelled',
) {
  const context = await requireAppointmentMutation(request, reply, environment, store);
  if (!context) return;
  const tenantId = context.tenant!._id;
  const before = await store.getAppointment(tenantId, request.params.appointmentPublicId);
  if (!before) return sendError(reply, 404, 'appointment_not_found', request.id);
  if (before.status === status)
    return reply.send(
      envelope(
        { ...(await appointmentDetailView(store, tenantId, before)), changed: false },
        request.id,
      ),
    );
  if (before.status !== 'scheduled')
    return sendError(reply, 409, 'invalid_appointment_transition', request.id);
  const early = status !== 'cancelled' && Date.now() < before.starts_at.valueOf();
  const override = 'early_override' in body && body.early_override === true;
  if (early && (!override || !overrideRoles.has(context.membership!.role)))
    return sendError(reply, 409, 'appointment_not_started', request.id);
  const cancellation = status === 'cancelled' ? (body as CancelBody) : undefined;
  const detail = cancellation?.detail?.trim() || null;
  if (detail && detail.length > 500)
    return sendError(reply, 400, 'invalid_appointment_request', request.id);
  if (cancellation?.reason && !cancellationReasons.includes(cancellation.reason))
    return sendError(reply, 400, 'invalid_appointment_request', request.id);
  try {
    const transition = await store.withAppointmentScheduleLocks(
      tenantId,
      utcDateScopes(before.provider_id, before.blocked_starts_at, before.blocked_ends_at),
      async (session) => {
        const current = await store.getAppointment(
          tenantId,
          request.params.appointmentPublicId,
          session,
        );
        if (!current) throw new AppointmentRuleError(404, 'appointment_not_found');
        if (current.status === status) return { item: current, changed: false };
        if (current.status !== 'scheduled')
          throw new AppointmentRuleError(409, 'invalid_appointment_transition');
        if (current.version !== body.expected_version)
          throw new AppointmentRuleError(409, 'version_conflict');
        const result = await store.transitionAppointment({
          appointment: current,
          tenantId,
          userId: context.user._id,
          expectedVersion: body.expected_version,
          status,
          ...(cancellation ? { reason: cancellation.reason ?? null, detail } : {}),
          session,
        });
        if (result !== 'updated') throw new AppointmentRuleError(409, 'version_conflict');
        const item = (await store.getAppointment(tenantId, current.public_id, session))!;
        if (status === 'cancelled')
          await enqueueLifecycleEmail(
            store,
            context.tenant!,
            item,
            'appointment_cancelled',
            request.id,
            session,
          );
        return {
          item,
          changed: true,
        };
      },
    );
    if (transition.changed)
      await appointmentAudit(store, context, request.id, event, transition.item, {
        prior_version: String(before.version),
        new_version: String(transition.item.version),
        prior_status: before.status,
        new_status: transition.item.status,
        early_override: early && override ? 'true' : 'false',
        cancellation_reason: cancellation?.reason ?? null,
      });
    return reply.send(
      envelope(
        {
          ...(await appointmentDetailView(store, tenantId, transition.item)),
          changed: transition.changed,
        },
        request.id,
      ),
    );
  } catch (reason) {
    return handleRuleError(reason, reply, request.id);
  }
}

async function loadSubject(
  store: AdminStore,
  tenantId: ObjectId,
  customerPublicId: string,
  providerPublicId: string,
  servicePublicId: string,
  session: ClientSession,
) {
  const customer = await store.getCustomer(tenantId, customerPublicId, session);
  if (!customer) throw new AppointmentRuleError(404, 'customer_not_found');
  if (customer.status !== 'active') throw new AppointmentRuleError(409, 'inactive_customer');
  const provider = await store.getProvider(tenantId, providerPublicId, session);
  if (!provider) throw new AppointmentRuleError(404, 'provider_not_found');
  if (provider.status !== 'active') throw new AppointmentRuleError(409, 'inactive_provider');
  const service = await store.getService(tenantId, servicePublicId, session);
  if (!service) throw new AppointmentRuleError(404, 'service_not_found');
  if (service.status !== 'active') throw new AppointmentRuleError(409, 'inactive_service');
  const assignment = await store.findAppointmentAssignment(
    tenantId,
    provider._id,
    service._id,
    session,
  );
  if (!assignment) throw new AppointmentRuleError(404, 'assignment_not_found');
  if (assignment.status !== 'active') throw new AppointmentRuleError(409, 'inactive_assignment');
  return { customer, provider, service, assignment };
}

async function loadSubjectByAppointment(
  store: AdminStore,
  tenantId: ObjectId,
  appointment: AppointmentDocument,
  session: ClientSession,
) {
  const customerRecord = await store.getCustomerById(tenantId, appointment.customer_id, session);
  if (!customerRecord) throw new AppointmentRuleError(404, 'customer_not_found');
  if (customerRecord.status !== 'active') throw new AppointmentRuleError(409, 'inactive_customer');
  const provider = await store.getProviderById(tenantId, appointment.provider_id, session);
  if (!provider) throw new AppointmentRuleError(404, 'provider_not_found');
  if (provider.status !== 'active') throw new AppointmentRuleError(409, 'inactive_provider');
  const service = await store.getServiceById(tenantId, appointment.service_id, session);
  if (!service) throw new AppointmentRuleError(404, 'service_not_found');
  if (service.status !== 'active') throw new AppointmentRuleError(409, 'inactive_service');
  const assignment = await store.findAppointmentAssignment(
    tenantId,
    provider._id,
    service._id,
    session,
  );
  if (!assignment) throw new AppointmentRuleError(404, 'assignment_not_found');
  if (assignment.status !== 'active') throw new AppointmentRuleError(409, 'inactive_assignment');
  return { customer: customerRecord, provider, service, assignment };
}

async function validateCandidate(input: {
  store: AdminStore;
  tenantId: ObjectId;
  subject: Awaited<ReturnType<typeof loadSubject>>;
  start: Date;
  session: ClientSession;
  tenantDefaultCadence: number;
  terms?: {
    duration: number;
    before: number;
    after: number;
    timezone: string;
    cadence: number;
  };
  excludeAppointmentId?: ObjectId;
}) {
  const schedule = await input.store.getAvailabilitySchedule(
    input.tenantId,
    input.subject.provider._id,
    input.session,
  );
  if (!schedule) throw new AppointmentRuleError(409, 'provider_unavailable');
  const duration = input.terms?.duration ?? input.subject.service.duration_minutes;
  const before = input.terms?.before ?? input.subject.assignment.buffer_before_minutes;
  const after = input.terms?.after ?? input.subject.assignment.buffer_after_minutes;
  const timezone = input.terms?.timezone ?? schedule.timezone;
  const localDate = localDateFor(input.start, timezone);
  const exceptions = (
    await input.store.listAvailabilityExceptions(
      input.tenantId,
      input.subject.provider._id,
      input.session,
    )
  ).filter((item) => item.status === 'active');
  const cadence =
    input.terms?.cadence ??
    input.subject.service.slot_cadence_minutes ??
    input.tenantDefaultCadence;
  const slots = generateSlots(
    previewDay(localDate, schedule, exceptions, duration, before, after).windows,
    timezone,
    cadence,
    duration,
    before,
    after,
  );
  const slot = slots.find((item) => item.starts_at === input.start.toISOString());
  if (!slot) throw new AppointmentRuleError(409, 'provider_unavailable');
  const blockedStartsAt = new Date(slot.blocked_starts_at);
  const blockedEndsAt = new Date(slot.blocked_ends_at);
  const conflicts = await input.store.listBlockingAppointments({
    tenantId: input.tenantId,
    providerId: input.subject.provider._id,
    startsBefore: blockedEndsAt,
    endsAfter: blockedStartsAt,
    ...(input.excludeAppointmentId ? { excludeAppointmentId: input.excludeAppointmentId } : {}),
    session: input.session,
  });
  if (conflicts.length) throw new AppointmentRuleError(409, 'appointment_conflict');
  return {
    starts_at: input.start,
    ends_at: new Date(slot.service_ends_at),
    blocked_starts_at: blockedStartsAt,
    blocked_ends_at: blockedEndsAt,
    timezone,
    local_start_date: localDate,
  };
}

function selectAddress(
  mode: AppointmentDocument['location']['mode'],
  addresses: CustomerAddressDocument[],
  publicId: string | null | undefined,
): AppointmentDocument['location']['customer_address'] {
  if (mode !== 'customer_location') return null;
  const selected = publicId
    ? addresses.find((item) => item.public_id === publicId)
    : addresses.find((item) => item.is_primary);
  if (!selected) throw new AppointmentRuleError(400, 'customer_address_required');
  return {
    line_1: selected.line_1,
    line_2: selected.line_2,
    city: selected.city,
    region: selected.region,
    postal_code: selected.postal_code,
    country_code: selected.country_code,
  };
}

function utcDateScopes(providerId: ObjectId, start: Date, end: Date) {
  const dates = [];
  for (
    let date = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    date <= Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    date += 86_400_000
  )
    dates.push({ providerId, utcDate: new Date(date).toISOString().slice(0, 10) });
  return dates;
}

function localDateFor(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function appointmentRange(
  query: { view?: string; start_date?: string; end_date?: string },
  timezone: string,
) {
  const today = localDateFor(new Date(), timezone);
  if (query.start_date || query.end_date) {
    if (!query.start_date || !query.end_date || query.start_date > query.end_date) return;
    const start = localToUtc(query.start_date, 0, timezone, 'earlier');
    const dayAfter = nextLocalDate(query.end_date);
    if (
      !start ||
      !dayAfter ||
      (Date.parse(`${query.end_date}T12:00:00Z`) - Date.parse(`${query.start_date}T12:00:00Z`)) /
        86_400_000 >
        92
    )
      return;
    return { startsAtFrom: start, startsAtBefore: localToUtc(dayAfter, 0, timezone, 'later') };
  }
  if (query.view === 'past') return { startsAtBefore: localToUtc(today, 0, timezone, 'earlier') };
  if (query.view === 'today')
    return {
      startsAtFrom: localToUtc(today, 0, timezone, 'earlier'),
      startsAtBefore: localToUtc(nextLocalDate(today)!, 0, timezone, 'later'),
    };
  return { startsAtFrom: new Date() };
}

function nextLocalDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return;
  return new Date(date.valueOf() + 86_400_000).toISOString().slice(0, 10);
}

function parseStatuses(value: string | undefined): AppointmentStatus[] | undefined {
  if (!value) return undefined;
  const statuses = [...new Set(value.split(',').filter(Boolean))];
  return statuses.every((item): item is AppointmentStatus =>
    APPOINTMENT_STATUSES.includes(item as AppointmentStatus),
  )
    ? statuses
    : undefined;
}

function cursorFingerprint(direction: string, query: Record<string, unknown>) {
  return JSON.stringify({
    direction,
    view: query.view ?? 'upcoming',
    start_date: query.start_date ?? null,
    end_date: query.end_date ?? null,
    status: query.status ?? null,
    provider_public_id: query.provider_public_id ?? null,
    service_public_id: query.service_public_id ?? null,
    customer_query: query.customer_query ?? null,
    reference: query.reference ?? null,
  });
}

function encodeAppointmentCursor(
  item: AppointmentDocument,
  direction: string,
  query: Record<string, unknown>,
) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      fingerprint: cursorFingerprint(direction, query),
      starts_at: item.starts_at.toISOString(),
      public_id: item.public_id,
    }),
  ).toString('base64url');
}

function decodeAppointmentCursor(
  cursor: string,
  direction: string,
  query: Record<string, unknown>,
) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      value.v !== 1 ||
      value.fingerprint !== cursorFingerprint(direction, query) ||
      typeof value.starts_at !== 'string' ||
      typeof value.public_id !== 'string'
    )
      return;
    const startsAt = new Date(value.starts_at);
    if (Number.isNaN(startsAt.valueOf())) return;
    return { startsAt, publicId: value.public_id };
  } catch {
    return;
  }
}

function appointmentSummaryView(item: AppointmentDocument) {
  return {
    public_id: item.public_id,
    reference: item.reference,
    customer: { display_name: item.snapshot.customer_display_name },
    provider: { display_name: item.snapshot.provider_display_name },
    service: { name: item.snapshot.service_name },
    starts_at: item.starts_at.toISOString(),
    ends_at: item.ends_at.toISOString(),
    timezone: item.timezone,
    local_start_date: item.local_start_date,
    status: item.status,
    version: item.version,
  };
}

async function appointmentDetailView(
  store: AdminStore,
  tenantId: ObjectId,
  item: AppointmentDocument,
) {
  const [customer, provider, service, notifications] = await Promise.all([
    store.getCustomerById(tenantId, item.customer_id),
    store.getProviderById(tenantId, item.provider_id),
    store.getServiceById(tenantId, item.service_id),
    store.listAppointmentNotifications(tenantId, item._id),
  ]);
  return {
    ...appointmentSummaryView(item),
    customer: {
      public_id: customer?.public_id ?? null,
      display_name: item.snapshot.customer_display_name,
    },
    provider: {
      public_id: provider?.public_id ?? null,
      display_name: item.snapshot.provider_display_name,
    },
    service: { public_id: service?.public_id ?? null, name: item.snapshot.service_name },
    blocked_starts_at: item.blocked_starts_at.toISOString(),
    blocked_ends_at: item.blocked_ends_at.toISOString(),
    snapshot: item.snapshot,
    location: item.location,
    source: item.source,
    cancellation_reason: item.cancellation_reason,
    cancellation_detail: item.cancellation_detail,
    cancelled_at: item.cancelled_at?.toISOString() ?? null,
    completed_at: item.completed_at?.toISOString() ?? null,
    no_show_at: item.no_show_at?.toISOString() ?? null,
    created_at: item.created_at.toISOString(),
    updated_at: item.updated_at.toISOString(),
    email_notifications: notifications.map((notification) => ({
      public_id: notification.public_id,
      type: notification.type,
      status: notification.status === 'delivered' ? 'sent' : notification.status,
      created_at: notification.created_at.toISOString(),
      sent_at: notification.delivered_at?.toISOString() ?? null,
    })),
  };
}

async function enqueueLifecycleEmail(
  store: AdminStore,
  tenant: NonNullable<VerifiedAdminContext['tenant']>,
  appointment: AppointmentDocument,
  type: 'appointment_rescheduled' | 'appointment_cancelled',
  requestId: string,
  session: ClientSession,
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
    });
}

function customerDisplayName(customer: Awaited<ReturnType<AdminStore['getCustomer']>> & {}) {
  return [customer.preferred_name ?? customer.first_name, customer.last_name]
    .filter(Boolean)
    .join(' ');
}

async function requireAppointmentRole(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AdminStore,
) {
  const context = await authenticateAdminRequest(request, store);
  if (!context) return sendError(reply, 401, 'authentication_required', request.id);
  if (!context.tenant || !context.membership)
    return sendError(reply, 409, 'tenant_selection_required', request.id);
  if (!appointmentRoles.has(context.membership.role))
    return sendError(reply, 403, 'forbidden', request.id);
  return context;
}

async function requireAppointmentMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
) {
  const context = await authenticateAdminMutation(request, reply, environment, store);
  if (!context) return;
  if (!context.tenant || !context.membership)
    return sendError(reply, 409, 'tenant_selection_required', request.id);
  if (!appointmentRoles.has(context.membership.role))
    return sendError(reply, 403, 'forbidden', request.id);
  return context;
}

async function appointmentAudit(
  store: AdminStore,
  context: VerifiedAdminContext,
  requestId: string,
  event: string,
  item: AppointmentDocument,
  metadata: Record<string, string | null>,
) {
  const [customer, provider, service] = await Promise.all([
    store.getCustomerById(context.tenant!._id, item.customer_id),
    store.getProviderById(context.tenant!._id, item.provider_id),
    store.getServiceById(context.tenant!._id, item.service_id),
  ]);
  await store.audit({
    event,
    outcome: 'success',
    actorUserId: context.user._id,
    tenantId: context.tenant!._id,
    requestId,
    metadata: {
      appointment_public_id: item.public_id,
      appointment_reference: item.reference,
      customer_public_id: customer?.public_id ?? null,
      provider_public_id: provider?.public_id ?? null,
      service_public_id: service?.public_id ?? null,
      ...metadata,
    },
  });
}

function parseInstant(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function handleRuleError(reason: unknown, reply: FastifyReply, requestId: string) {
  if (reason instanceof AppointmentRuleError)
    return sendError(reply, reason.status, reason.code, requestId);
  throw reason;
}

function envelope<T>(data: T, requestId: string) {
  return { data, meta: { request_id: requestId } };
}

function sendError(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: {
      code,
      message: 'The appointment request could not be completed.',
      request_id: requestId,
    },
  });
}

const cancelSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expected_version'],
  properties: {
    expected_version: expectedVersionSchema,
    reason: { anyOf: [{ type: 'string', enum: [...cancellationReasons] }, { type: 'null' }] },
    detail: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
  },
} as const;
