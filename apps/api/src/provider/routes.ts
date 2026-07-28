import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  type AdminStore,
  type ProviderCursor,
  type ProviderDocument,
  type ProviderServiceAssignmentDocument,
  type ServiceDocument,
  type VerifiedAdminContext,
} from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

const managers = new Set(['tenant_owner', 'tenant_admin']);
const versionSchema = { type: 'integer', minimum: 1 } as const;
const providerProperties = {
  internal_code: {
    anyOf: [
      { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      { type: 'null' },
    ],
  },
  display_name: { type: 'string', minLength: 1, maxLength: 160 },
  first_name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
  last_name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
  email: {
    anyOf: [
      { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
      { type: 'null' },
    ],
  },
  phone: { anyOf: [{ type: 'string', pattern: '^\\+[1-9][0-9]{1,14}$' }, { type: 'null' }] },
  photo_url: {
    anyOf: [{ type: 'string', maxLength: 2048, pattern: '^https://' }, { type: 'null' }],
  },
  bio: { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'null' }] },
  customer_selectable: { type: 'boolean' },
  accepting_new_clients: { type: 'boolean' },
  display_order: { type: 'integer', minimum: 0, maximum: 1000000 },
  linked_user_id: false,
} as const;

interface ProviderBody {
  internal_code?: string | null;
  display_name: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  photo_url?: string | null;
  bio?: string | null;
  customer_selectable?: boolean;
  accepting_new_clients?: boolean;
  display_order?: number;
}
interface ProviderPatchBody extends Partial<ProviderBody> {
  expected_version: number;
}
interface VersionBody {
  expected_version: number;
}
interface AssignmentBody {
  service_public_id: string;
}

export function registerProviderRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get<{
    Querystring: { status?: 'active' | 'inactive' | 'all'; cursor?: string; limit?: number };
  }>(
    '/api/v1/admin/providers',
    {
      schema: {
        operationId: 'listProviders',
        tags: ['providers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'inactive', 'all'], default: 'all' },
            cursor: { type: 'string', maxLength: 1024 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const after = request.query.cursor ? decodeCursor(request.query.cursor) : undefined;
      if (request.query.cursor && !after)
        return sendError(reply, 400, 'invalid_cursor', request.id);
      const limit = request.query.limit ?? 25;
      const documents = await store.listProviders({
        tenantId: context.tenant!._id,
        ...(request.query.status && request.query.status !== 'all'
          ? { status: request.query.status }
          : {}),
        ...(after ? { after } : {}),
        limit: limit + 1,
      });
      const items = documents.slice(0, limit);
      const next = documents.length > limit ? encodeCursor(items.at(-1)!) : null;
      return reply.send(
        envelope({ items: items.map(providerView), next_cursor: next }, request.id),
      );
    },
  );

  app.post<{ Body: ProviderBody }>(
    '/api/v1/admin/providers',
    {
      schema: {
        operationId: 'createProvider',
        tags: ['providers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['display_name'],
          properties: providerProperties,
        },
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      try {
        const provider = await store.createProvider(
          context.tenant!._id,
          context.user._id,
          normalizeProvider(request.body),
        );
        await audit(store, context, request.id, 'provider_created', {
          provider_public_id: provider.public_id,
          internal_code: provider.internal_code,
        });
        return reply.status(201).send(envelope(providerView(provider), request.id));
      } catch (error) {
        if (isDuplicateKey(error))
          return sendError(reply, 409, 'internal_code_conflict', request.id);
        throw error;
      }
    },
  );

  app.get<{ Params: { providerPublicId: string } }>(
    '/api/v1/admin/providers/:providerPublicId',
    { schema: { operationId: 'getProvider', tags: ['providers'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return sendError(reply, 404, 'provider_not_found', request.id);
      const assignments = await assignmentViewsForProvider(store, context.tenant!._id, provider);
      return reply.send(
        envelope({ ...providerView(provider), service_assignments: assignments }, request.id),
      );
    },
  );

  app.patch<{ Params: { providerPublicId: string }; Body: ProviderPatchBody }>(
    '/api/v1/admin/providers/:providerPublicId',
    {
      schema: {
        operationId: 'updateProvider',
        tags: ['providers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version'],
          properties: { expected_version: versionSchema, ...providerProperties },
        },
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const { expected_version, ...body } = request.body;
      const before = await store.getProvider(context.tenant!._id, request.params.providerPublicId);
      try {
        const result = await store.updateProvider({
          tenantId: context.tenant!._id,
          publicId: request.params.providerPublicId,
          userId: context.user._id,
          expectedVersion: expected_version,
          changes: normalizeProviderPatch(body),
        });
        if (result !== 'updated')
          return mutationFailure(reply, result, request.id, 'provider_not_found');
        await audit(store, context, request.id, 'provider_updated', {
          provider_public_id: request.params.providerPublicId,
          fields: Object.keys(body).sort().join(','),
          prior_version: String(before?.version ?? expected_version),
          new_version: String(expected_version + 1),
        });
        return reply.send(
          envelope(
            providerView(
              (await store.getProvider(context.tenant!._id, request.params.providerPublicId))!,
            ),
            request.id,
          ),
        );
      } catch (error) {
        if (isDuplicateKey(error))
          return sendError(reply, 409, 'internal_code_conflict', request.id);
        throw error;
      }
    },
  );

  for (const status of ['active', 'inactive'] as const) {
    const action = status === 'active' ? 'activate' : 'deactivate';
    app.post<{ Params: { providerPublicId: string }; Body: VersionBody }>(
      `/api/v1/admin/providers/:providerPublicId/${action}`,
      {
        schema: {
          operationId: `${action}Provider`,
          tags: ['providers'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expected_version'],
            properties: { expected_version: versionSchema },
          },
        },
      },
      async (request, reply) => {
        const context = await requireManager(request, reply, environment, store);
        if (!context) return;
        const before = await store.getProvider(
          context.tenant!._id,
          request.params.providerPublicId,
        );
        const result = await store.transitionProvider({
          tenantId: context.tenant!._id,
          publicId: request.params.providerPublicId,
          userId: context.user._id,
          expectedVersion: request.body.expected_version,
          status,
        });
        if (result === 'not_found' || result === 'version_conflict')
          return mutationFailure(reply, result, request.id, 'provider_not_found');
        if (result === 'updated')
          await audit(
            store,
            context,
            request.id,
            `provider_${status === 'active' ? 'activated' : 'deactivated'}`,
            {
              provider_public_id: request.params.providerPublicId,
              prior_version: String(before?.version ?? request.body.expected_version),
              new_version: String((before?.version ?? request.body.expected_version) + 1),
            },
          );
        const provider = await store.getProvider(
          context.tenant!._id,
          request.params.providerPublicId,
        );
        return reply.send(
          envelope({ ...providerView(provider!), changed: result === 'updated' }, request.id),
        );
      },
    );
  }

  app.get<{ Params: { providerPublicId: string } }>(
    '/api/v1/admin/providers/:providerPublicId/service-assignments',
    { schema: { operationId: 'listProviderServiceAssignments', tags: ['provider-assignments'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      if (!provider) return sendError(reply, 404, 'provider_not_found', request.id);
      return reply.send(
        envelope(
          await assignmentViewsForProvider(store, context.tenant!._id, provider),
          request.id,
        ),
      );
    },
  );

  app.post<{ Params: { providerPublicId: string }; Body: AssignmentBody }>(
    '/api/v1/admin/providers/:providerPublicId/service-assignments',
    {
      schema: {
        operationId: 'createProviderServiceAssignment',
        tags: ['provider-assignments'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['service_public_id'],
          properties: { service_public_id: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const context = await requireManager(request, reply, environment, store);
      if (!context) return;
      const provider = await store.getProvider(
        context.tenant!._id,
        request.params.providerPublicId,
      );
      const service = await store.getService(context.tenant!._id, request.body.service_public_id);
      if (!provider || !service)
        return sendError(reply, 404, 'assignment_target_not_found', request.id);
      const created = await store.createAssignment({
        tenantId: context.tenant!._id,
        providerId: provider._id,
        serviceId: service._id,
        userId: context.user._id,
      });
      if (created.result === 'inactive')
        return reply.status(409).send({
          error: {
            code: 'assignment_inactive',
            message: 'The assignment exists but is inactive.',
            request_id: request.id,
            assignment_public_id: created.assignment.public_id,
            version: created.assignment.version,
          },
        });
      if (created.result === 'created')
        await audit(store, context, request.id, 'provider_service_assignment_created', {
          provider_public_id: provider.public_id,
          service_public_id: service.public_id,
          assignment_public_id: created.assignment.public_id,
        });
      return reply.status(created.result === 'created' ? 201 : 200).send(
        envelope(
          {
            ...assignmentView(created.assignment, service, provider),
            changed: created.result === 'created',
          },
          request.id,
        ),
      );
    },
  );

  for (const status of ['active', 'inactive'] as const) {
    const action = status === 'active' ? 'activate' : 'deactivate';
    app.post<{
      Params: { providerPublicId: string; assignmentPublicId: string };
      Body: VersionBody;
    }>(
      `/api/v1/admin/providers/:providerPublicId/service-assignments/:assignmentPublicId/${action}`,
      {
        schema: {
          operationId: `${action}ProviderServiceAssignment`,
          tags: ['provider-assignments'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expected_version'],
            properties: { expected_version: versionSchema },
          },
        },
      },
      async (request, reply) => {
        const context = await requireManager(request, reply, environment, store);
        if (!context) return;
        const provider = await store.getProvider(
          context.tenant!._id,
          request.params.providerPublicId,
        );
        if (!provider) return sendError(reply, 404, 'assignment_not_found', request.id);
        const existing = await store.getAssignment(
          context.tenant!._id,
          provider._id,
          request.params.assignmentPublicId,
        );
        if (!existing) return sendError(reply, 404, 'assignment_not_found', request.id);
        const result = await store.transitionAssignment({
          tenantId: context.tenant!._id,
          providerId: provider._id,
          publicId: request.params.assignmentPublicId,
          userId: context.user._id,
          expectedVersion: request.body.expected_version,
          status,
        });
        if (result === 'not_found' || result === 'version_conflict')
          return mutationFailure(reply, result, request.id, 'assignment_not_found');
        if (result === 'updated')
          await audit(
            store,
            context,
            request.id,
            `provider_service_assignment_${status === 'active' ? 'activated' : 'deactivated'}`,
            {
              provider_public_id: provider.public_id,
              assignment_public_id: existing.public_id,
              service_public_id:
                (await store.getServiceById(context.tenant!._id, existing.service_id))?.public_id ??
                'unavailable',
              prior_version: String(existing.version),
              new_version: String(existing.version + 1),
            },
          );
        const assignment = (await store.getAssignment(
          context.tenant!._id,
          provider._id,
          existing.public_id,
        ))!;
        const service = (await store.getServiceById(context.tenant!._id, assignment.service_id))!;
        return reply.send(
          envelope(
            { ...assignmentView(assignment, service, provider), changed: result === 'updated' },
            request.id,
          ),
        );
      },
    );
  }

  app.get<{ Params: { servicePublicId: string } }>(
    '/api/v1/admin/services/:servicePublicId/provider-assignments',
    { schema: { operationId: 'listServiceProviderAssignments', tags: ['provider-assignments'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const service = await store.getService(context.tenant!._id, request.params.servicePublicId);
      if (!service) return sendError(reply, 404, 'service_not_found', request.id);
      const assignments = await store.listAssignmentsForService(context.tenant!._id, service._id);
      const views = [];
      for (const assignment of assignments) {
        const provider = await store.getProviderById(context.tenant!._id, assignment.provider_id);
        if (provider) views.push(assignmentView(assignment, service, provider));
      }
      return reply.send(envelope(views, request.id));
    },
  );
}

async function assignmentViewsForProvider(
  store: AdminStore,
  tenantId: ProviderDocument['tenant_id'],
  provider: ProviderDocument,
) {
  const documents = await store.listAssignmentsForProvider(tenantId, provider._id);
  const views = [];
  for (const assignment of documents) {
    const service = await store.getServiceById(tenantId, assignment.service_id);
    if (service) views.push(assignmentView(assignment, service, provider));
  }
  return views;
}
function assignmentView(
  assignment: ProviderServiceAssignmentDocument,
  service: ServiceDocument,
  provider: ProviderDocument,
) {
  return {
    public_id: assignment.public_id,
    status: assignment.status,
    version: assignment.version,
    buffer_before_minutes: assignment.buffer_before_minutes,
    buffer_after_minutes: assignment.buffer_after_minutes,
    provider: {
      public_id: provider.public_id,
      display_name: provider.display_name,
      status: provider.status,
      customer_selectable: provider.customer_selectable,
      accepting_new_clients: provider.accepting_new_clients,
    },
    service: { public_id: service.public_id, name: service.name, status: service.status },
    operationally_eligible:
      assignment.status === 'active' && provider.status === 'active' && service.status === 'active',
    created_at: assignment.created_at.toISOString(),
    updated_at: assignment.updated_at.toISOString(),
  };
}
function providerView(provider: ProviderDocument) {
  return {
    public_id: provider.public_id,
    internal_code: provider.internal_code,
    display_name: provider.display_name,
    first_name: provider.first_name,
    last_name: provider.last_name,
    email: provider.email_normalized,
    phone: provider.phone_e164,
    photo_url: provider.photo_url,
    bio: provider.bio,
    status: provider.status,
    customer_selectable: provider.customer_selectable,
    accepting_new_clients: provider.accepting_new_clients,
    display_order: provider.display_order,
    version: provider.version,
    created_at: provider.created_at.toISOString(),
    updated_at: provider.updated_at.toISOString(),
  };
}
function normalizeProvider(body: ProviderBody) {
  return {
    internal_code: normalizeCode(body.internal_code),
    display_name: body.display_name.trim(),
    first_name: normalizeNullable(body.first_name),
    last_name: normalizeNullable(body.last_name),
    email_normalized: normalizeNullable(body.email)?.toLowerCase() ?? null,
    phone_e164: normalizeNullable(body.phone),
    photo_url: normalizeNullable(body.photo_url),
    bio: normalizeNullable(body.bio),
    customer_selectable: body.customer_selectable ?? true,
    accepting_new_clients: body.accepting_new_clients ?? true,
    display_order: body.display_order ?? 0,
  };
}
function normalizeProviderPatch(body: Partial<ProviderBody>) {
  const changes: Record<string, unknown> = {};
  for (const key of [
    'display_name',
    'customer_selectable',
    'accepting_new_clients',
    'display_order',
  ] as const)
    if (body[key] !== undefined)
      changes[key] = key === 'display_name' ? body[key].trim() : body[key];
  if (body.internal_code !== undefined) changes.internal_code = normalizeCode(body.internal_code);
  for (const [source, target] of [
    ['first_name', 'first_name'],
    ['last_name', 'last_name'],
    ['email', 'email_normalized'],
    ['phone', 'phone_e164'],
    ['photo_url', 'photo_url'],
    ['bio', 'bio'],
  ] as const)
    if (body[source] !== undefined)
      changes[target] =
        source === 'email'
          ? (normalizeNullable(body[source])?.toLowerCase() ?? null)
          : normalizeNullable(body[source]);
  return changes;
}
function encodeCursor(provider: ProviderDocument) {
  return Buffer.from(
    JSON.stringify([provider.display_order, provider.display_name, provider.public_id]),
  ).toString('base64url');
}
function decodeCursor(value: string): ProviderCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      !Number.isInteger(parsed[0]) ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string'
    )
      return;
    return { displayOrder: parsed[0] as number, displayName: parsed[1], publicId: parsed[2] };
  } catch {
    return;
  }
}
async function requireTenant(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AdminStore,
): Promise<VerifiedAdminContext | null> {
  const context = await authenticateAdminRequest(request, store);
  if (!context) {
    await sendError(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!context.tenant || !context.membership) {
    await sendError(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  return context;
}
async function requireManager(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
): Promise<VerifiedAdminContext | null> {
  const context = await authenticateAdminMutation(request, reply, environment, store);
  if (!context) return null;
  if (!context.tenant || !context.membership) {
    await sendError(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  if (!managers.has(context.membership.role)) {
    await sendError(reply, 403, 'insufficient_role', request.id);
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
function mutationFailure(reply: FastifyReply, result: string, requestId: string, notFound: string) {
  return sendError(
    reply,
    result === 'version_conflict' ? 409 : 404,
    result === 'version_conflict' ? result : notFound,
    requestId,
  );
}
function sendError(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}
function normalizeCode(value: string | null | undefined) {
  return value?.trim() ? value.trim().toUpperCase() : null;
}
function normalizeNullable(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}
function isDuplicateKey(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
