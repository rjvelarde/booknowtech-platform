import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AdminStore,
  AvailabilityExceptionDocument,
  AvailabilityInterval,
  ProviderAvailabilityScheduleDocument,
  VerifiedAdminContext,
} from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

const managers = new Set(['tenant_owner', 'tenant_admin']);
const intervalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['day_of_week', 'start_minute', 'end_minute'],
  properties: {
    day_of_week: { type: 'integer', minimum: 1, maximum: 7 },
    start_minute: { type: 'integer', minimum: 0, maximum: 1439 },
    end_minute: { type: 'integer', minimum: 1, maximum: 1440 },
  },
} as const;
interface ScheduleBody {
  timezone: string;
  weekly_hours: AvailabilityInterval[];
  breaks: AvailabilityInterval[];
  expected_version?: number;
}
interface ExceptionBody {
  scope: 'tenant' | 'provider';
  provider_public_id?: string | null;
  kind: 'holiday' | 'closure' | 'time_off';
  name?: string | null;
  all_day: boolean;
  timezone: string;
  starts_on?: string | null;
  ends_before?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  expected_version?: number;
}

export function registerAvailabilityRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get<{ Params: { providerPublicId: string } }>(
    '/api/v1/admin/providers/:providerPublicId/availability-schedule',
    { schema: { operationId: 'getProviderAvailabilitySchedule', tags: ['availability'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return error(reply, 404, 'provider_not_found', request.id);
      const schedule = await store.getAvailabilitySchedule(context.tenant!._id, provider._id);
      if (!schedule) return error(reply, 404, 'availability_schedule_not_found', request.id);
      return reply.send(envelope(scheduleView(schedule), request.id));
    },
  );
  app.post<{ Params: { providerPublicId: string }; Body: ScheduleBody }>(
    '/api/v1/admin/providers/:providerPublicId/availability-schedule',
    {
      schema: {
        operationId: 'createProviderAvailabilitySchedule',
        tags: ['availability'],
        body: scheduleSchema(false),
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return error(reply, 404, 'provider_not_found', request.id);
      const validation = validateSchedule(request.body);
      if (validation) return error(reply, 400, validation, request.id);
      try {
        const schedule = await store.createAvailabilitySchedule({
          tenantId: context.tenant!._id,
          providerId: provider._id,
          userId: context.user._id,
          timezone: request.body.timezone,
          weeklyHours: request.body.weekly_hours,
          breaks: request.body.breaks,
        });
        await audit(store, context, request.id, 'provider_availability_schedule_created', {
          provider_public_id: provider.public_id,
          schedule_public_id: schedule.public_id,
        });
        return reply.status(201).send(envelope(scheduleView(schedule), request.id));
      } catch (e) {
        if (isDuplicate(e)) return error(reply, 409, 'availability_schedule_exists', request.id);
        throw e;
      }
    },
  );
  app.patch<{ Params: { providerPublicId: string }; Body: ScheduleBody }>(
    '/api/v1/admin/providers/:providerPublicId/availability-schedule',
    {
      schema: {
        operationId: 'updateProviderAvailabilitySchedule',
        tags: ['availability'],
        body: scheduleSchema(true),
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return error(reply, 404, 'provider_not_found', request.id);
      const validation = validateSchedule(request.body);
      if (validation) return error(reply, 400, validation, request.id);
      const result = await store.updateAvailabilitySchedule({
        tenantId: context.tenant!._id,
        providerId: provider._id,
        userId: context.user._id,
        expectedVersion: request.body.expected_version!,
        timezone: request.body.timezone,
        weeklyHours: request.body.weekly_hours,
        breaks: request.body.breaks,
      });
      if (result !== 'updated')
        return mutationError(reply, result, request.id, 'availability_schedule_not_found');
      const schedule = (await store.getAvailabilitySchedule(context.tenant!._id, provider._id))!;
      await audit(store, context, request.id, 'provider_availability_schedule_updated', {
        provider_public_id: provider.public_id,
        prior_version: String(request.body.expected_version),
        new_version: String(schedule.version),
      });
      return reply.send(envelope(scheduleView(schedule), request.id));
    },
  );
  app.get<{ Querystring: { provider_public_id?: string } }>(
    '/api/v1/admin/availability-exceptions',
    { schema: { operationId: 'listAvailabilityExceptions', tags: ['availability'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      let providerId;
      if (request.query.provider_public_id) {
        const provider = await store.getProvider(
          context.tenant!._id,
          request.query.provider_public_id,
        );
        if (!provider) return error(reply, 404, 'provider_not_found', request.id);
        providerId = provider._id;
      }
      const items = await store.listAvailabilityExceptions(context.tenant!._id, providerId);
      return reply.send(envelope(items.map(exceptionView), request.id));
    },
  );
  app.post<{ Body: ExceptionBody }>(
    '/api/v1/admin/availability-exceptions',
    {
      schema: {
        operationId: 'createAvailabilityException',
        tags: ['availability'],
        body: exceptionSchema(false),
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const normalized = await normalizeException(request.body, context, store);
      if (typeof normalized === 'string')
        return error(
          reply,
          normalized === 'provider_not_found' ? 404 : 400,
          normalized,
          request.id,
        );
      const item = await store.createAvailabilityException({
        ...normalized,
        tenant_id: context.tenant!._id,
        userId: context.user._id,
        status: 'active',
      });
      await audit(store, context, request.id, 'availability_exception_created', {
        exception_public_id: item.public_id,
        kind: item.kind,
      });
      return reply.status(201).send(envelope(exceptionView(item), request.id));
    },
  );
  app.patch<{ Params: { exceptionPublicId: string }; Body: ExceptionBody }>(
    '/api/v1/admin/availability-exceptions/:exceptionPublicId',
    {
      schema: {
        operationId: 'updateAvailabilityException',
        tags: ['availability'],
        body: exceptionSchema(true),
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const current = await store.getAvailabilityException(
        context.tenant!._id,
        request.params.exceptionPublicId,
      );
      if (!current) return error(reply, 404, 'availability_exception_not_found', request.id);
      const normalized = await normalizeException(request.body, context, store);
      if (typeof normalized === 'string')
        return error(
          reply,
          normalized === 'provider_not_found' ? 404 : 400,
          normalized,
          request.id,
        );
      if (
        normalized.scope !== current.scope ||
        String(normalized.provider_id) !== String(current.provider_id) ||
        normalized.kind !== current.kind
      )
        return error(reply, 400, 'immutable_exception_scope', request.id);
      const result = await store.updateAvailabilityException({
        tenantId: context.tenant!._id,
        publicId: current.public_id,
        userId: context.user._id,
        expectedVersion: request.body.expected_version!,
        changes: normalized,
      });
      if (result !== 'updated')
        return mutationError(reply, result, request.id, 'availability_exception_not_found');
      const item = (await store.getAvailabilityException(context.tenant!._id, current.public_id))!;
      await audit(store, context, request.id, 'availability_exception_updated', {
        exception_public_id: item.public_id,
        prior_version: String(request.body.expected_version),
        new_version: String(item.version),
      });
      return reply.send(envelope(exceptionView(item), request.id));
    },
  );
  for (const status of ['active', 'inactive'] as const) {
    const action = status === 'active' ? 'activate' : 'deactivate';
    app.post<{ Params: { exceptionPublicId: string }; Body: { expected_version: number } }>(
      `/api/v1/admin/availability-exceptions/:exceptionPublicId/${action}`,
      { schema: { operationId: `${action}AvailabilityException`, tags: ['availability'] } },
      async (request, reply) => {
        const context = await requireManager(request, reply, environment, store);
        if (!context) return;
        const result = await store.transitionAvailabilityException({
          tenantId: context.tenant!._id,
          publicId: request.params.exceptionPublicId,
          userId: context.user._id,
          expectedVersion: request.body.expected_version,
          status,
        });
        if (result === 'not_found' || result === 'version_conflict')
          return mutationError(reply, result, request.id, 'availability_exception_not_found');
        const item = (await store.getAvailabilityException(
          context.tenant!._id,
          request.params.exceptionPublicId,
        ))!;
        if (result === 'updated')
          await audit(store, context, request.id, `availability_exception_${action}d`, {
            exception_public_id: item.public_id,
            new_version: String(item.version),
          });
        return reply.send(
          envelope({ ...exceptionView(item), changed: result === 'updated' }, request.id),
        );
      },
    );
  }
  app.patch<{
    Params: { providerPublicId: string; assignmentPublicId: string };
    Body: { expected_version: number; buffer_before_minutes: number; buffer_after_minutes: number };
  }>(
    '/api/v1/admin/providers/:providerPublicId/service-assignments/:assignmentPublicId/buffers',
    { schema: { operationId: 'updateProviderServiceBuffers', tags: ['availability'] } },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return error(reply, 404, 'provider_not_found', request.id);
      const {
        expected_version,
        buffer_before_minutes: before,
        buffer_after_minutes: after,
      } = request.body;
      if (
        !Number.isInteger(before) ||
        !Number.isInteger(after) ||
        before < 0 ||
        after < 0 ||
        before > 1440 ||
        after > 1440
      )
        return error(reply, 400, 'invalid_buffer', request.id);
      const result = await store.updateAssignmentBuffers({
        tenantId: context.tenant!._id,
        providerId: provider._id,
        publicId: request.params.assignmentPublicId,
        userId: context.user._id,
        expectedVersion: expected_version,
        before,
        after,
      });
      if (result === 'not_found' || result === 'version_conflict')
        return mutationError(reply, result, request.id, 'assignment_not_found');
      const item = (await store.getAssignment(
        context.tenant!._id,
        provider._id,
        request.params.assignmentPublicId,
      ))!;
      if (result === 'updated')
        await audit(store, context, request.id, 'provider_service_buffers_updated', {
          assignment_public_id: item.public_id,
          prior_version: String(expected_version),
          new_version: String(item.version),
        });
      return reply.send(
        envelope(
          {
            public_id: item.public_id,
            buffer_before_minutes: item.buffer_before_minutes,
            buffer_after_minutes: item.buffer_after_minutes,
            version: item.version,
            changed: result === 'updated',
          },
          request.id,
        ),
      );
    },
  );
  app.get<{
    Params: { providerPublicId: string };
    Querystring: { service_public_id: string; start_date: string; end_date: string };
  }>(
    '/api/v1/admin/providers/:providerPublicId/availability-preview',
    { schema: { operationId: 'previewProviderAvailability', tags: ['availability'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      const service = await store.getService(context.tenant!._id, request.query.service_public_id);
      if (!provider || !service)
        return error(reply, 404, 'availability_subject_not_found', request.id);
      const assignment = (
        await store.listAssignmentsForProvider(context.tenant!._id, provider._id)
      ).find((x) => x.service_id.equals(service._id));
      if (!assignment) return error(reply, 404, 'assignment_not_found', request.id);
      const schedule = await store.getAvailabilitySchedule(context.tenant!._id, provider._id);
      const eligible =
        provider.status === 'active' &&
        service.status === 'active' &&
        assignment.status === 'active' &&
        !!schedule;
      if (!eligible)
        return reply.send(
          envelope(
            {
              eligible: false,
              timezone: schedule?.timezone ?? context.tenant!.default_timezone,
              days: [],
            },
            request.id,
          ),
        );
      const dates = dateRange(request.query.start_date, request.query.end_date);
      if (!dates) return error(reply, 400, 'invalid_preview_range', request.id);
      const exceptions = (
        await store.listAvailabilityExceptions(context.tenant!._id, provider._id)
      ).filter((x) => x.status === 'active');
      const days = dates.map((date) =>
        previewDay(
          date,
          schedule,
          exceptions,
          service.duration_minutes,
          assignment.buffer_before_minutes,
          assignment.buffer_after_minutes,
        ),
      );
      return reply.send(
        envelope({ eligible: true, timezone: schedule.timezone, days }, request.id),
      );
    },
  );
}

function scheduleSchema(update: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...(update ? ['expected_version'] : []), 'timezone', 'weekly_hours', 'breaks'],
    properties: {
      expected_version: { type: 'integer', minimum: 1 },
      timezone: { type: 'string', minLength: 1, maxLength: 100 },
      weekly_hours: { type: 'array', maxItems: 70, items: intervalSchema },
      breaks: { type: 'array', maxItems: 70, items: intervalSchema },
    },
  } as const;
}
function exceptionSchema(update: boolean) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...(update ? ['expected_version'] : []), 'scope', 'kind', 'all_day', 'timezone'],
    properties: {
      expected_version: { type: 'integer', minimum: 1 },
      scope: { type: 'string', enum: ['tenant', 'provider'] },
      provider_public_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      kind: { type: 'string', enum: ['holiday', 'closure', 'time_off'] },
      name: { anyOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] },
      all_day: { type: 'boolean' },
      timezone: { type: 'string' },
      starts_on: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      ends_before: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      starts_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      ends_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  } as const;
}
function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}
export function validateSchedule(body: ScheduleBody): string | undefined {
  if (!validTimezone(body.timezone)) return 'invalid_timezone';
  for (const x of [...body.weekly_hours, ...body.breaks])
    if (x.start_minute >= x.end_minute) return 'invalid_interval';
  for (const group of [body.weekly_hours, body.breaks])
    for (let day = 1; day <= 7; day++) {
      const items = group
        .filter((x) => x.day_of_week === day)
        .sort((a, b) => a.start_minute - b.start_minute);
      if (items.some((x, i) => i > 0 && x.start_minute < items[i - 1]!.end_minute))
        return 'overlapping_intervals';
    }
  if (
    body.breaks.some(
      (b) =>
        !body.weekly_hours.some(
          (h) =>
            h.day_of_week === b.day_of_week &&
            h.start_minute <= b.start_minute &&
            h.end_minute >= b.end_minute,
        ),
    )
  )
    return 'break_outside_working_hours';
  return undefined;
}
async function normalizeException(
  body: ExceptionBody,
  context: VerifiedAdminContext,
  store: AdminStore,
) {
  if (!validTimezone(body.timezone)) return 'invalid_timezone';
  let provider_id = null;
  if (body.scope === 'provider') {
    if (body.kind !== 'time_off' || !body.provider_public_id) return 'invalid_exception_scope';
    const provider = await store.getProvider(context.tenant!._id, body.provider_public_id);
    if (!provider) return 'provider_not_found';
    provider_id = provider._id;
  } else if (body.kind === 'time_off' || body.provider_public_id) return 'invalid_exception_scope';
  if (body.all_day) {
    if (
      !validLocalDate(body.starts_on) ||
      !validLocalDate(body.ends_before) ||
      body.starts_on >= body.ends_before
    )
      return 'invalid_exception_range';
    return {
      scope: body.scope,
      provider_id,
      kind: body.kind,
      name: body.name?.trim() || null,
      all_day: true,
      timezone: body.timezone,
      starts_on: body.starts_on,
      ends_before: body.ends_before,
      starts_at: null,
      ends_at: null,
    };
  }
  const start = body.starts_at ? new Date(body.starts_at) : null,
    end = body.ends_at ? new Date(body.ends_at) : null;
  if (!start || !end || Number.isNaN(start.valueOf()) || start >= end)
    return 'invalid_exception_range';
  return {
    scope: body.scope,
    provider_id,
    kind: body.kind,
    name: body.name?.trim() || null,
    all_day: false,
    timezone: body.timezone,
    starts_on: null,
    ends_before: null,
    starts_at: start,
    ends_at: end,
  };
}
function scheduleView(x: ProviderAvailabilityScheduleDocument) {
  return {
    public_id: x.public_id,
    timezone: x.timezone,
    weekly_hours: x.weekly_hours,
    breaks: x.breaks,
    version: x.version,
    updated_at: x.updated_at.toISOString(),
  };
}
function exceptionView(x: AvailabilityExceptionDocument) {
  return {
    public_id: x.public_id,
    scope: x.scope,
    kind: x.kind,
    name: x.name,
    all_day: x.all_day,
    timezone: x.timezone,
    starts_on: x.starts_on,
    ends_before: x.ends_before,
    starts_at: x.starts_at?.toISOString() ?? null,
    ends_at: x.ends_at?.toISOString() ?? null,
    status: x.status,
    version: x.version,
  };
}
export function dateRange(start: string, end: string) {
  if (!validLocalDate(start) || !validLocalDate(end) || start > end) return;
  const out: string[] = [];
  for (
    let d = new Date(`${start}T12:00:00Z`);
    out.length < 32;
    d = new Date(d.valueOf() + 86400000)
  ) {
    const value = d.toISOString().slice(0, 10);
    if (value > end) break;
    out.push(value);
  }
  return out.length && out.length <= 31 ? out : undefined;
}
function validLocalDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function previewDay(
  date: string,
  schedule: Pick<ProviderAvailabilityScheduleDocument, 'timezone' | 'weekly_hours' | 'breaks'>,
  exceptions: Array<
    Pick<
      AvailabilityExceptionDocument,
      'all_day' | 'starts_on' | 'ends_before' | 'starts_at' | 'ends_at'
    >
  >,
  duration: number,
  before: number,
  after: number,
) {
  const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  let localWindows: [number, number][] = schedule.weekly_hours
    .filter((x) => x.day_of_week === weekday)
    .map((x) => [x.start_minute, x.end_minute] as [number, number]);
  for (const cut of schedule.breaks.filter((x) => x.day_of_week === weekday))
    localWindows = subtract(localWindows, [cut.start_minute, cut.end_minute]);
  for (const x of exceptions)
    if (x.all_day && x.starts_on && x.ends_before && x.starts_on <= date && date < x.ends_before)
      localWindows = [];
  let windows = localWindows.map(
    ([start, end]) =>
      [
        localToUtc(date, start, schedule.timezone, 'earlier').valueOf(),
        localToUtc(date, end, schedule.timezone, 'later').valueOf(),
      ] as [number, number],
  );
  for (const x of exceptions)
    if (!x.all_day && x.starts_at && x.ends_at)
      windows = subtract(windows, [x.starts_at.valueOf(), x.ends_at.valueOf()]);
  const rendered = [];
  for (const [start, end] of windows) {
    if (end - start < (before + duration + after) * 60000) continue;
    const startsAt = new Date(start),
      endsAt = new Date(end),
      earliest = new Date(start + before * 60000),
      latest = new Date(end - (duration + after) * 60000);
    rendered.push({
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      local_start: localIso(startsAt, schedule.timezone),
      local_end: localIso(endsAt, schedule.timezone),
      earliest_service_start_at: earliest.toISOString(),
      latest_service_start_at: latest.toISOString(),
      local_earliest_service_start: localIso(earliest, schedule.timezone),
      local_latest_service_start: localIso(latest, schedule.timezone),
    });
  }
  return { local_date: date, windows: rendered };
}
function subtract(windows: [number, number][], cut: [number, number]): [number, number][] {
  return windows.flatMap(([a, b]) => {
    if (cut[1] <= a || cut[0] >= b) return [[a, b]];
    const parts: [number, number][] = [
      [a, Math.max(a, cut[0])],
      [Math.min(b, cut[1]), b],
    ];
    return parts.filter(([start, end]) => start < end);
  });
}
function localToUtc(date: string, minute: number, zone: string, choice: 'earlier' | 'later') {
  const normalized = normalizeLocal(date, minute);
  date = normalized.date;
  minute = normalized.minute;
  const [y = 0, m = 0, d = 0] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const matches: Date[] = [];
  for (let t = target - 18 * 3600000; t <= target + 18 * 3600000; t += 60000) {
    const p = parts(new Date(t), zone);
    if (
      p ===
      `${date} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    )
      matches.push(new Date(t));
  }
  if (matches.length) return choice === 'earlier' ? matches[0]! : matches.at(-1)!;
  for (let add = 1; add <= 180; add++) {
    const next = localToUtcSafe(date, minute + add, zone);
    if (next) return next;
  }
  throw new Error('Unable to resolve local time');
}
function normalizeLocal(date: string, minute: number) {
  if (minute < 1440) return { date, minute };
  return {
    date: new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10),
    minute: minute - 1440,
  };
}
function localToUtcSafe(date: string, minute: number, zone: string): Date | undefined {
  const [y = 0, m = 0, d = 0] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  for (let t = target - 18 * 3600000; t <= target + 18 * 3600000; t += 60000)
    if (
      parts(new Date(t), zone) ===
      `${date} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    )
      return new Date(t);
  return undefined;
}
function parts(date: Date, zone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}
function localIso(date: Date, zone: string) {
  const value = parts(date, zone).replace(' ', 'T');
  const utcEquivalent = Date.parse(`${value}:00Z`);
  const offset = (utcEquivalent - date.valueOf()) / 60000;
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${value}:00${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}
async function requireTenant(request: FastifyRequest, reply: FastifyReply, store: AdminStore) {
  const context = await authenticateAdminRequest(request, store);
  if (!context) {
    await error(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!context.tenant || !context.membership) {
    await error(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  return context;
}
async function requireManager(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
) {
  const context = await authenticateAdminMutation(request, reply, environment, store);
  if (!context) return null;
  if (!context.tenant || !context.membership) {
    await error(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  if (!managers.has(context.membership.role)) {
    await error(reply, 403, 'insufficient_role', request.id);
    return null;
  }
  return context;
}
async function audit(
  store: AdminStore,
  context: VerifiedAdminContext,
  requestId: string,
  event: string,
  metadata: Record<string, string | null>,
) {
  await store.audit({
    event,
    outcome: 'success',
    actorUserId: context.user._id,
    tenantId: context.tenant!._id,
    requestId,
    metadata,
  });
}
function envelope(data: unknown, requestId: string) {
  return { data, meta: { request_id: requestId } };
}
function error(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}
function mutationError(reply: FastifyReply, result: string, requestId: string, notFound: string) {
  return error(
    reply,
    result === 'version_conflict' ? 409 : 404,
    result === 'version_conflict' ? result : notFound,
    requestId,
  );
}
function isDuplicate(e: unknown) {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 11000;
}
