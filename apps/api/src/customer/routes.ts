import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  type AdminStore,
  type CustomerAddressDocument,
  type CustomerCursor,
  type CustomerDocument,
  type VerifiedAdminContext,
} from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import type { Environment } from '../config.js';

const customerRoles = new Set(['tenant_owner', 'tenant_admin', 'front_desk']);
const preferenceValues = ['unknown', 'opted_in', 'opted_out'] as const;
const channelValues = ['email', 'sms', 'phone', 'none'] as const;
const versionSchema = { type: 'integer', minimum: 1 } as const;

interface AddressBody {
  public_id?: string;
  label: CustomerAddressDocument['label'];
  line_1: string;
  line_2?: string | null;
  city: string;
  region: string;
  postal_code: string;
  country_code?: string;
  is_primary?: boolean;
}
interface PreferencesBody {
  preferred_channel?: CustomerDocument['communication_preferences']['preferred_channel'];
  marketing_email?: CustomerDocument['communication_preferences']['marketing_email'];
  marketing_sms?: CustomerDocument['communication_preferences']['marketing_sms'];
}
interface CustomerBody {
  first_name: string;
  last_name?: string | null;
  preferred_name?: string | null;
  email?: string | null;
  mobile_phone?: string | null;
  addresses?: AddressBody[];
  communication_preferences?: PreferencesBody;
  acknowledge_possible_duplicate?: boolean;
}
interface CustomerPatchBody extends Partial<CustomerBody> {
  expected_version: number;
}
interface VersionBody {
  expected_version: number;
}

const addressProperties = {
  public_id: { type: 'string', minLength: 1, maxLength: 100 },
  label: { type: 'string', enum: ['home', 'work', 'other'] },
  line_1: { type: 'string', minLength: 1, maxLength: 200 },
  line_2: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
  city: { type: 'string', minLength: 1, maxLength: 200 },
  region: { type: 'string', minLength: 1, maxLength: 200 },
  postal_code: { type: 'string', minLength: 1, maxLength: 32 },
  country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
  is_primary: { type: 'boolean' },
} as const;
const preferenceProperties = {
  preferred_channel: {
    anyOf: [{ type: 'string', enum: [...channelValues] }, { type: 'null' }],
  },
  marketing_email: { type: 'string', enum: [...preferenceValues] },
  marketing_sms: { type: 'string', enum: [...preferenceValues] },
} as const;
const customerProperties = {
  first_name: { type: 'string', minLength: 1, maxLength: 100 },
  last_name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
  preferred_name: {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }],
  },
  email: {
    anyOf: [
      { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
      { type: 'null' },
    ],
  },
  mobile_phone: { anyOf: [{ type: 'string', minLength: 7, maxLength: 32 }, { type: 'null' }] },
  addresses: {
    type: 'array',
    maxItems: 5,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'line_1', 'city', 'region', 'postal_code'],
      properties: addressProperties,
    },
  },
  communication_preferences: {
    type: 'object',
    additionalProperties: false,
    properties: preferenceProperties,
  },
  acknowledge_possible_duplicate: { type: 'boolean' },
} as const;

export function registerCustomerRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
): void {
  app.get<{
    Querystring: {
      status?: 'active' | 'inactive' | 'all';
      q?: string;
      cursor?: string;
      limit?: number;
    };
  }>(
    '/api/v1/admin/customers',
    {
      schema: {
        operationId: 'listCustomers',
        tags: ['customers'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'inactive', 'all'], default: 'active' },
            q: { type: 'string', minLength: 2, maxLength: 100 },
            cursor: { type: 'string', maxLength: 2048 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await requireCustomerRole(request, reply, store);
      if (!context) return;
      const query = normalizeSearch(request.query.q);
      const status = request.query.status ?? 'active';
      const after = request.query.cursor
        ? decodeCursor(request.query.cursor, status, query.text)
        : undefined;
      if (request.query.cursor && !after)
        return sendError(reply, 400, 'invalid_cursor', request.id);
      const limit = request.query.limit ?? 25;
      const documents = await store.listCustomers({
        tenantId: context.tenant!._id,
        ...(status !== 'all' ? { status } : {}),
        ...(query.text ? { textPrefix: query.text } : {}),
        ...(query.phone ? { phonePrefix: query.phone } : {}),
        ...(after ? { after } : {}),
        limit: limit + 1,
      });
      const items = documents.slice(0, limit);
      return reply.send(
        envelope(
          {
            items: items.map(customerSummaryView),
            next_cursor:
              documents.length > limit ? encodeCursor(items.at(-1)!, status, query.text) : null,
          },
          request.id,
        ),
      );
    },
  );

  app.post<{ Body: CustomerBody }>(
    '/api/v1/admin/customers/duplicate-check',
    {
      schema: {
        operationId: 'checkCustomerDuplicates',
        tags: ['customers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['first_name'],
          properties: customerProperties,
        },
      },
    },
    async (request, reply) => {
      const context = await requireCustomerMutation(request, reply, environment, store);
      if (!context) return;
      const normalized = safeNormalizeCustomer(request.body);
      if (!normalized) return sendError(reply, 400, 'invalid_phone', request.id);
      const addressError = validateAddresses(normalized.addresses);
      if (addressError) return sendError(reply, 400, addressError, request.id);
      const matches = await duplicateMatches(store, context, normalized);
      return reply.send(envelope({ matches }, request.id));
    },
  );

  app.post<{ Body: CustomerBody }>(
    '/api/v1/admin/customers',
    {
      schema: {
        operationId: 'createCustomer',
        tags: ['customers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['first_name'],
          properties: customerProperties,
        },
      },
    },
    async (request, reply) => {
      const context = await requireCustomerMutation(request, reply, environment, store);
      if (!context) return;
      const normalized = safeNormalizeCustomer(request.body);
      if (!normalized) return sendError(reply, 400, 'invalid_phone', request.id);
      const addressError = validateAddresses(normalized.addresses);
      if (addressError) return sendError(reply, 400, addressError, request.id);
      const matches = await duplicateMatches(store, context, normalized);
      if (matches.length && !request.body.acknowledge_possible_duplicate)
        return reply.status(409).send({
          error: {
            code: 'possible_duplicate',
            message: 'Possible existing customers require review.',
            request_id: request.id,
            candidates: matches,
          },
        });
      const customer = await store.createCustomer({
        tenantId: context.tenant!._id,
        userId: context.user._id,
        customer: {
          ...normalized,
          source: 'manual',
          external_references: [],
        },
      });
      await audit(store, context, request.id, 'customer_created', {
        customer_public_id: customer.public_id,
        duplicate_acknowledged: matches.length ? 'true' : 'false',
        duplicate_reasons: [...new Set(matches.flatMap((match) => match.reasons))].sort().join(','),
      });
      return reply.status(201).send(envelope(customerDetailView(customer, true), request.id));
    },
  );

  app.get<{ Params: { customerPublicId: string } }>(
    '/api/v1/admin/customers/:customerPublicId',
    { schema: { operationId: 'getCustomer', tags: ['customers'] } },
    async (request, reply) => {
      const context = await requireCustomerRole(request, reply, store);
      if (!context) return;
      const customer = await store.getCustomer(
        context.tenant!._id,
        request.params.customerPublicId,
      );
      if (!customer) return sendError(reply, 404, 'customer_not_found', request.id);
      return reply.send(
        envelope(
          customerDetailView(customer, context.membership!.role !== 'front_desk'),
          request.id,
        ),
      );
    },
  );

  app.patch<{ Params: { customerPublicId: string }; Body: CustomerPatchBody }>(
    '/api/v1/admin/customers/:customerPublicId',
    {
      schema: {
        operationId: 'updateCustomer',
        tags: ['customers'],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expected_version'],
          properties: { expected_version: versionSchema, ...customerProperties },
        },
      },
    },
    async (request, reply) => {
      const context = await requireCustomerMutation(request, reply, environment, store);
      if (!context) return;
      const before = await store.getCustomer(context.tenant!._id, request.params.customerPublicId);
      if (!before) return sendError(reply, 404, 'customer_not_found', request.id);
      const {
        expected_version,
        acknowledge_possible_duplicate: ignoredAcknowledgement,
        ...body
      } = request.body;
      void ignoredAcknowledgement;
      const normalized = safeNormalizeCustomer(
        {
          first_name: body.first_name ?? before.first_name,
          last_name: body.last_name !== undefined ? body.last_name : before.last_name,
          preferred_name:
            body.preferred_name !== undefined ? body.preferred_name : before.preferred_name,
          email: body.email !== undefined ? body.email : before.email_normalized,
          mobile_phone:
            body.mobile_phone !== undefined ? body.mobile_phone : before.mobile_phone_e164,
          addresses: body.addresses ?? before.addresses.map((address) => ({ ...address })),
          communication_preferences:
            body.communication_preferences ?? before.communication_preferences,
        },
        true,
      );
      if (!normalized) return sendError(reply, 400, 'invalid_phone', request.id);
      const addressError = validateAddresses(normalized.addresses);
      if (addressError) return sendError(reply, 400, addressError, request.id);
      const duplicateWarnings = await duplicateMatches(
        store,
        context,
        normalized,
        before.public_id,
      );
      const result = await store.updateCustomer({
        tenantId: context.tenant!._id,
        publicId: before.public_id,
        userId: context.user._id,
        expectedVersion: expected_version,
        changes: normalized,
      });
      if (result === 'version_conflict')
        return sendError(reply, 409, 'version_conflict', request.id);
      if (result === 'not_found') return sendError(reply, 404, 'customer_not_found', request.id);
      if (result === 'updated')
        await audit(store, context, request.id, 'customer_updated', {
          customer_public_id: before.public_id,
          fields: Object.keys(body).sort().join(','),
          prior_version: String(before.version),
          new_version: String(before.version + 1),
        });
      const updated = (await store.getCustomer(context.tenant!._id, before.public_id))!;
      return reply.send(
        envelope(
          {
            ...customerDetailView(updated, true),
            changed: result === 'updated',
            duplicate_warnings: duplicateWarnings,
          },
          request.id,
        ),
      );
    },
  );

  for (const status of ['active', 'inactive'] as const) {
    const action = status === 'active' ? 'activate' : 'deactivate';
    app.post<{ Params: { customerPublicId: string }; Body: VersionBody }>(
      `/api/v1/admin/customers/:customerPublicId/${action}`,
      {
        schema: {
          operationId: `${action}Customer`,
          tags: ['customers'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expected_version'],
            properties: { expected_version: versionSchema },
          },
        },
      },
      async (request, reply) => {
        const context = await requireCustomerMutation(request, reply, environment, store);
        if (!context) return;
        const before = await store.getCustomer(
          context.tenant!._id,
          request.params.customerPublicId,
        );
        const result = await store.transitionCustomer({
          tenantId: context.tenant!._id,
          publicId: request.params.customerPublicId,
          userId: context.user._id,
          expectedVersion: request.body.expected_version,
          status,
        });
        if (result === 'version_conflict')
          return sendError(reply, 409, 'version_conflict', request.id);
        if (result === 'not_found') return sendError(reply, 404, 'customer_not_found', request.id);
        if (result === 'updated')
          await audit(store, context, request.id, `customer_${action}d`, {
            customer_public_id: request.params.customerPublicId,
            prior_version: String(before?.version ?? request.body.expected_version),
            new_version: String((before?.version ?? request.body.expected_version) + 1),
          });
        const customer = (await store.getCustomer(
          context.tenant!._id,
          request.params.customerPublicId,
        ))!;
        return reply.send(
          envelope(
            { ...customerDetailView(customer, true), changed: result === 'updated' },
            request.id,
          ),
        );
      },
    );
  }
}

function normalizeCustomer(body: CustomerBody, preserveAddressIds = false) {
  const firstName = body.first_name.trim();
  const lastName = normalizeNullable(body.last_name);
  const email = normalizeNullable(body.email)?.toLowerCase() ?? null;
  const phone = normalizePhone(body.mobile_phone);
  return {
    first_name: firstName,
    last_name: lastName,
    preferred_name: normalizeNullable(body.preferred_name),
    first_name_normalized: normalizeText(firstName),
    last_name_normalized: lastName ? normalizeText(lastName) : null,
    full_name_normalized: normalizeText([firstName, lastName].filter(Boolean).join(' ')),
    email_normalized: email,
    mobile_phone_e164: phone,
    mobile_phone_digits: phone?.replace(/\D/g, '') ?? null,
    addresses: (body.addresses ?? []).map((address) =>
      normalizeAddress(address, preserveAddressIds),
    ),
    communication_preferences: {
      preferred_channel: body.communication_preferences?.preferred_channel ?? null,
      marketing_email: body.communication_preferences?.marketing_email ?? 'unknown',
      marketing_sms: body.communication_preferences?.marketing_sms ?? 'unknown',
    },
  };
}

function safeNormalizeCustomer(body: CustomerBody, preserveAddressIds = false) {
  try {
    const normalized = normalizeCustomer(body, preserveAddressIds);
    return normalized.first_name ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeAddress(
  address: AddressBody,
  preserveAddressId: boolean,
): CustomerAddressDocument {
  return {
    public_id: preserveAddressId && address.public_id ? address.public_id : randomUUID(),
    label: address.label,
    line_1: address.line_1.trim(),
    line_2: normalizeNullable(address.line_2),
    city: address.city.trim(),
    region: address.region.trim(),
    postal_code: address.postal_code.trim().toUpperCase(),
    country_code: (address.country_code ?? 'US').trim().toUpperCase(),
    is_primary: address.is_primary ?? false,
  };
}

function validateAddresses(addresses: CustomerAddressDocument[]) {
  return addresses.filter((address) => address.is_primary).length > 1
    ? 'multiple_primary_addresses'
    : null;
}

async function duplicateMatches(
  store: AdminStore,
  context: VerifiedAdminContext,
  customer: ReturnType<typeof normalizeCustomer>,
  excludePublicId?: string,
) {
  const postalCode = customer.addresses.find((address) => address.is_primary)?.postal_code ?? null;
  const documents = await store.findPossibleCustomers({
    tenantId: context.tenant!._id,
    email: customer.email_normalized,
    phone: customer.mobile_phone_e164,
    fullName: customer.full_name_normalized,
    postalCode,
    ...(excludePublicId ? { excludePublicId } : {}),
  });
  return documents.map((candidate) => {
    const reasons: string[] = [];
    if (customer.email_normalized && candidate.email_normalized === customer.email_normalized)
      reasons.push('email_exact');
    if (customer.mobile_phone_e164 && candidate.mobile_phone_e164 === customer.mobile_phone_e164)
      reasons.push('mobile_phone_exact');
    if (candidate.full_name_normalized === customer.full_name_normalized)
      reasons.push('full_name_exact');
    if (
      postalCode &&
      candidate.full_name_normalized === customer.full_name_normalized &&
      candidate.addresses.some(
        (address) => address.is_primary && address.postal_code === postalCode,
      )
    )
      reasons.push('full_name_and_postal_code');
    return { ...customerSummaryView(candidate), reasons };
  });
}

function customerSummaryView(customer: CustomerDocument) {
  return {
    public_id: customer.public_id,
    display_name: displayName(customer),
    first_name: customer.first_name,
    last_name: customer.last_name,
    preferred_name: customer.preferred_name,
    email: customer.email_normalized,
    mobile_phone: customer.mobile_phone_e164,
    status: customer.status,
    version: customer.version,
    updated_at: customer.updated_at.toISOString(),
  };
}

function customerDetailView(customer: CustomerDocument, includeExternalReferences: boolean) {
  return {
    ...customerSummaryView(customer),
    addresses: customer.addresses,
    communication_preferences: customer.communication_preferences,
    source: customer.source,
    ...(includeExternalReferences ? { external_references: customer.external_references } : {}),
    deactivated_at: customer.deactivated_at?.toISOString() ?? null,
    created_at: customer.created_at.toISOString(),
  };
}

function displayName(
  customer: Pick<CustomerDocument, 'first_name' | 'last_name' | 'preferred_name'>,
) {
  return [customer.preferred_name ?? customer.first_name, customer.last_name]
    .filter(Boolean)
    .join(' ');
}

function normalizeText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizeSearch(value: string | undefined) {
  const text = value ? normalizeText(value) : '';
  const phone = value?.replace(/\D/g, '') ?? '';
  return { text, phone: phone.length >= 3 ? phone : '' };
}

function normalizePhone(value: string | null | undefined) {
  const raw = normalizeNullable(value);
  if (!raw) return null;
  if (/^\+[1-9][0-9]{1,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  throw new Error('invalid_phone');
}

function encodeCursor(customer: CustomerDocument, status: string, query: string) {
  return Buffer.from(
    JSON.stringify([
      customer.last_name_normalized,
      customer.first_name_normalized,
      customer.public_id,
      status,
      query,
    ]),
  ).toString('base64url');
}

function decodeCursor(value: string, status: string, query: string): CustomerCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      (parsed[0] !== null && typeof parsed[0] !== 'string') ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string' ||
      parsed[3] !== status ||
      parsed[4] !== query
    )
      return;
    return {
      lastName: parsed[0] as string | null,
      firstName: parsed[1],
      publicId: parsed[2],
    };
  } catch {
    return;
  }
}

async function requireCustomerRole(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AdminStore,
) {
  const context = await authenticateAdminRequest(request, store);
  if (!context) {
    await sendError(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!context.tenant || !context.membership) {
    await sendError(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  if (!customerRoles.has(context.membership.role)) {
    await sendError(reply, 403, 'insufficient_role', request.id);
    return null;
  }
  return context;
}

async function requireCustomerMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
) {
  const context = await authenticateAdminMutation(request, reply, environment, store);
  if (!context) return null;
  if (!context.tenant || !context.membership) {
    await sendError(reply, 403, 'tenant_selection_required', request.id);
    return null;
  }
  if (!customerRoles.has(context.membership.role)) {
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

function normalizeNullable(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function envelope(data: unknown, requestId: string) {
  return { data, meta: { request_id: requestId } };
}

function sendError(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}
