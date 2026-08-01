import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminStore } from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

interface SettingsBody {
  expected_version: number;
  enabled: boolean;
  sender_name: string;
  reply_to_email: string | null;
}

const managers = new Set(['tenant_owner', 'tenant_admin']);

export function registerNotificationRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get('/api/v1/admin/appointment-email-settings', async (request, reply) => {
    const context = await requireManager(request, reply, store);
    if (!context) return;
    return reply.send({
      data: {
        ...context.tenant!.appointment_email_settings,
        version: context.tenant!.version,
      },
    });
  });

  app.patch<{ Body: SettingsBody }>(
    '/api/v1/admin/appointment-email-settings',
    {
      schema: {
        operationId: 'updateAppointmentEmailSettings',
        tags: ['notifications'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version', 'enabled', 'sender_name', 'reply_to_email'],
          properties: {
            expected_version: { type: 'integer', minimum: 1 },
            enabled: { type: 'boolean' },
            sender_name: { type: 'string', minLength: 1, maxLength: 120 },
            reply_to_email: {
              anyOf: [{ type: 'string', format: 'email', maxLength: 320 }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await authenticateAdminMutation(request, reply, environment, store);
      if (!context) return;
      if (!context.tenant || !context.membership || !managers.has(context.membership.role))
        return error(reply, 403, 'forbidden', request.id);
      const settings = {
        enabled: request.body.enabled,
        sender_name: request.body.sender_name.trim(),
        reply_to_email: request.body.reply_to_email?.trim().toLowerCase() ?? null,
      };
      if (!settings.sender_name) return error(reply, 400, 'validation_failed', request.id);
      const result = await store.updateAppointmentEmailSettings({
        tenantId: context.tenant._id,
        userId: context.user._id,
        expectedVersion: request.body.expected_version,
        settings,
      });
      if (result === 'version_conflict') return error(reply, 409, result, request.id);
      if (result === 'not_found') return error(reply, 404, 'not_found', request.id);
      if (result === 'updated')
        await store.audit({
          event: 'appointment_email_settings_updated',
          outcome: 'success',
          actorUserId: context.user._id,
          tenantId: context.tenant._id,
          requestId: request.id,
          metadata: { enabled: String(settings.enabled) },
        });
      const updated = await store.getBusinessProfile(context.tenant._id);
      return reply.send({
        data: {
          ...updated!.appointment_email_settings,
          version: updated!.version,
          changed: result === 'updated',
        },
      });
    },
  );
}

async function requireManager(request: FastifyRequest, reply: FastifyReply, store: AdminStore) {
  const context = await authenticateAdminRequest(request, store);
  if (!context) return error(reply, 401, 'authentication_required', request.id);
  if (!context.tenant || !context.membership)
    return error(reply, 409, 'tenant_selection_required', request.id);
  if (!managers.has(context.membership.role)) return error(reply, 403, 'forbidden', request.id);
  return context;
}

function error(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}
