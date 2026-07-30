import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  type AdminStore,
  DELIVERY_MODES,
  type ServiceDocument,
  type VerifiedAdminContext,
} from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

const managers = new Set(['tenant_owner', 'tenant_admin']);
const internalCodePattern = '^[A-Za-z0-9._-]+$';
const slotCadences = [5, 10, 15, 20, 30, 60] as const;

interface ProfilePatchBody {
  expected_version: number;
  display_name?: string;
  legal_name?: string | null;
  contact?: { email?: string | null; phone?: string | null; website?: string | null };
  default_timezone?: string;
  default_slot_cadence_minutes?: number;
  locale?: string;
  currency?: string;
}

interface ServiceBody {
  internal_code?: string | null;
  name: string;
  description?: string | null;
  delivery_mode: ServiceDocument['delivery_mode'];
  duration_minutes: number;
  base_price_minor: number;
  booking_fee_minor: number;
  slot_cadence_minutes?: number | null;
}

interface ServicePatchBody extends Partial<ServiceBody> {
  expected_version: number;
}

interface VersionBody {
  expected_version: number;
}

const versionSchema = { type: 'integer', minimum: 1 } as const;
const serviceProperties = {
  internal_code: {
    anyOf: [
      { type: 'string', minLength: 1, maxLength: 64, pattern: internalCodePattern },
      { type: 'null' },
    ],
  },
  name: { type: 'string', minLength: 1, maxLength: 160 },
  description: { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'null' }] },
  delivery_mode: { type: 'string', enum: [...DELIVERY_MODES] },
  duration_minutes: { type: 'integer', minimum: 5, maximum: 1440 },
  base_price_minor: { type: 'integer', minimum: 0, maximum: 999999999 },
  booking_fee_minor: { type: 'integer', minimum: 0, maximum: 999999999 },
  slot_cadence_minutes: {
    anyOf: [{ type: 'integer', enum: [...slotCadences] }, { type: 'null' }],
  },
} as const;

export function registerCatalogRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get(
    '/api/v1/admin/business-profile',
    { schema: { operationId: 'getBusinessProfile', tags: ['business-catalog'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const profile = await store.getBusinessProfile(context.tenant!._id);
      return reply.send(envelope(profileView(profile!), request.id));
    },
  );

  app.patch<{ Body: ProfilePatchBody }>(
    '/api/v1/admin/business-profile',
    {
      schema: {
        operationId: 'updateBusinessProfile',
        tags: ['business-catalog'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version'],
          properties: {
            expected_version: versionSchema,
            display_name: { type: 'string', minLength: 1, maxLength: 160 },
            legal_name: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
            contact: {
              type: 'object',
              additionalProperties: false,
              properties: {
                email: { anyOf: [{ type: 'string', maxLength: 320 }, { type: 'null' }] },
                phone: { anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }] },
                website: { anyOf: [{ type: 'string', maxLength: 2048 }, { type: 'null' }] },
              },
            },
            default_timezone: { type: 'string', minLength: 1, maxLength: 100 },
            default_slot_cadence_minutes: { type: 'integer', enum: [...slotCadences] },
            locale: { type: 'string', minLength: 2, maxLength: 35 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireManagerMutation(request, reply, environment, store);
      if (!context) return;
      const { expected_version: expectedVersion, contact, ...body } = request.body;
      const changes = {
        ...body,
        ...(contact
          ? {
              contact: {
                email_normalized: normalizeNullable(contact.email),
                phone_e164: normalizeNullable(contact.phone),
                website_url: normalizeNullable(contact.website),
              },
            }
          : {}),
      };
      const result = await store.updateBusinessProfile({
        tenantId: context.tenant!._id,
        userId: context.user._id,
        expectedVersion,
        changes,
      });
      if (result !== 'updated') return sendMutationFailure(reply, result, request.id);
      const updatedProfile = (await store.getBusinessProfile(context.tenant!._id))!;
      await store.audit({
        event: 'business_profile_updated',
        outcome: 'success',
        actorUserId: context.user._id,
        tenantId: context.tenant!._id,
        requestId: request.id,
        metadata: {
          fields: [...Object.keys(body), ...(contact ? ['contact'] : [])].sort().join(','),
          prior_version: String(expectedVersion),
          new_version: String(updatedProfile.version),
        },
      });
      return reply.send(envelope(profileView(updatedProfile), request.id));
    },
  );

  app.get(
    '/api/v1/admin/services',
    { schema: { operationId: 'listServices', tags: ['business-catalog'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const services = await store.listServices(context.tenant!._id);
      return reply.send(envelope(services.map(serviceView), request.id));
    },
  );

  app.post<{ Body: ServiceBody }>(
    '/api/v1/admin/services',
    {
      schema: {
        operationId: 'createService',
        tags: ['business-catalog'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'name',
            'delivery_mode',
            'duration_minutes',
            'base_price_minor',
            'booking_fee_minor',
          ],
          properties: serviceProperties,
        },
      },
    },
    async (request, reply) => {
      const context = await requireManagerMutation(request, reply, environment, store);
      if (!context) return;
      try {
        const service = await store.createService(context.tenant!, context.user._id, {
          ...request.body,
          internal_code: normalizeInternalCode(request.body.internal_code),
          description: normalizeNullable(request.body.description),
          slot_cadence_minutes: request.body.slot_cadence_minutes ?? null,
          status: 'active',
        });
        await store.audit({
          event: 'service_created',
          outcome: 'success',
          actorUserId: context.user._id,
          tenantId: context.tenant!._id,
          requestId: request.id,
          metadata: { service_public_id: service.public_id },
        });
        return reply.status(201).send(envelope(serviceView(service), request.id));
      } catch (error) {
        if (isDuplicateKey(error))
          return sendError(reply, 409, 'internal_code_conflict', request.id);
        throw error;
      }
    },
  );

  app.get<{ Params: { servicePublicId: string } }>(
    '/api/v1/admin/services/:servicePublicId',
    { schema: { operationId: 'getService', tags: ['business-catalog'] } },
    async (request, reply) => {
      const context = await requireTenant(request, reply, store);
      if (!context) return;
      const service = await store.getService(context.tenant!._id, request.params.servicePublicId);
      if (!service) return sendError(reply, 404, 'service_not_found', request.id);
      return reply.send(envelope(serviceView(service), request.id));
    },
  );

  app.patch<{ Params: { servicePublicId: string }; Body: ServicePatchBody }>(
    '/api/v1/admin/services/:servicePublicId',
    {
      schema: {
        operationId: 'updateService',
        tags: ['business-catalog'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version'],
          properties: { expected_version: versionSchema, ...serviceProperties },
        },
      },
    },
    async (request, reply) => {
      const context = await requireManagerMutation(request, reply, environment, store);
      if (!context) return;
      const { expected_version: expectedVersion, ...body } = request.body;
      try {
        const result = await store.updateService({
          tenantId: context.tenant!._id,
          publicId: request.params.servicePublicId,
          userId: context.user._id,
          expectedVersion,
          changes: {
            ...body,
            ...(body.internal_code !== undefined
              ? { internal_code: normalizeInternalCode(body.internal_code) }
              : {}),
            ...(body.description !== undefined
              ? { description: normalizeNullable(body.description) }
              : {}),
          },
        });
        if (result !== 'updated') return sendMutationFailure(reply, result, request.id);
        const updatedService = (await store.getService(
          context.tenant!._id,
          request.params.servicePublicId,
        ))!;
        await store.audit({
          event: 'service_updated',
          outcome: 'success',
          actorUserId: context.user._id,
          tenantId: context.tenant!._id,
          requestId: request.id,
          metadata: {
            service_public_id: request.params.servicePublicId,
            fields: Object.keys(body).sort().join(','),
            prior_version: String(expectedVersion),
            new_version: String(updatedService.version),
          },
        });
        return reply.send(envelope(serviceView(updatedService), request.id));
      } catch (error) {
        if (isDuplicateKey(error))
          return sendError(reply, 409, 'internal_code_conflict', request.id);
        throw error;
      }
    },
  );

  for (const status of ['active', 'inactive'] as const) {
    const action = status === 'active' ? 'activate' : 'deactivate';
    app.post<{ Params: { servicePublicId: string }; Body: VersionBody }>(
      `/api/v1/admin/services/:servicePublicId/${action}`,
      {
        schema: {
          operationId: `${action}Service`,
          tags: ['business-catalog'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expected_version'],
            properties: { expected_version: versionSchema },
          },
        },
      },
      async (request, reply) => {
        const context = await requireManagerMutation(request, reply, environment, store);
        if (!context) return;
        const result = await store.transitionService({
          tenantId: context.tenant!._id,
          publicId: request.params.servicePublicId,
          userId: context.user._id,
          expectedVersion: request.body.expected_version,
          status,
        });
        if (result === 'not_found' || result === 'version_conflict') {
          return sendMutationFailure(reply, result, request.id);
        }
        if (result === 'updated') {
          await store.audit({
            event: `service_${status === 'active' ? 'activated' : 'deactivated'}`,
            outcome: 'success',
            actorUserId: context.user._id,
            tenantId: context.tenant!._id,
            requestId: request.id,
            metadata: { service_public_id: request.params.servicePublicId },
          });
        }
        const service = await store.getService(context.tenant!._id, request.params.servicePublicId);
        return reply.send(
          envelope({ ...serviceView(service!), changed: result === 'updated' }, request.id),
        );
      },
    );
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

async function requireManagerMutation(
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

function profileView(profile: NonNullable<Awaited<ReturnType<AdminStore['getBusinessProfile']>>>) {
  return {
    public_id: profile.public_id,
    slug: profile.slug,
    display_name: profile.display_name,
    legal_name: profile.legal_name,
    contact: {
      email: profile.contact.email_normalized,
      phone: profile.contact.phone_e164,
      website: profile.contact.website_url,
    },
    default_timezone: profile.default_timezone,
    default_slot_cadence_minutes: profile.default_slot_cadence_minutes,
    locale: profile.locale,
    currency: profile.currency,
    version: profile.version,
    updated_at: profile.updated_at.toISOString(),
  };
}

function serviceView(service: ServiceDocument) {
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
    publicly_bookable: service.publicly_bookable,
    public_display_order: service.public_display_order,
    public_booking_policy: service.public_booking_policy,
    status: service.status,
    version: service.version,
    created_at: service.created_at.toISOString(),
    updated_at: service.updated_at.toISOString(),
  };
}

function envelope(data: unknown, requestId: string) {
  return { data, meta: { request_id: requestId } };
}

function sendMutationFailure(reply: FastifyReply, result: string, requestId: string) {
  if (result === 'version_conflict') return sendError(reply, 409, result, requestId);
  if (result === 'currency_locked') return sendError(reply, 409, result, requestId);
  return sendError(reply, 404, 'not_found', requestId);
}

function sendError(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}

function normalizeInternalCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : null;
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
