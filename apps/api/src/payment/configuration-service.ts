import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, MongoServerError, ObjectId } from 'mongodb';
import { type PaymentMode, normalizeServicePaymentConfiguration } from './domain.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type EnvironmentName = 'staging' | 'production';
type OperationType =
  'activate_booking_fee' | 'activate_service_configuration' | 'set_tenant_execution';

interface CommonInput {
  database: Db;
  environment: EnvironmentName;
  operatorId: string;
  reason: string;
  requestId: string;
  tenantSlug: string;
}

interface ResultEvidence {
  version: number | null;
  public_id: string | null;
  enabled: boolean | null;
  payment_mode: PaymentMode | null;
  amount_minor: number | null;
}

interface TenantDocument {
  _id: ObjectId;
  public_id: string;
  status: string;
  currency: string;
  slug: string;
}

interface ConfigurationOperationDocument {
  _id: ObjectId;
  public_id: string;
  request_id: string;
  operation_type: OperationType;
  request_fingerprint: string;
  operator_id: string;
  reason: string;
  environment: EnvironmentName;
  tenant_public_id: string;
  service_public_id: string | null;
  status: 'completed';
  result: ResultEvidence;
  created_at: Date;
  completed_at: Date;
}

export interface ConfigurationResult extends ResultEvidence {
  outcome: 'completed' | 'replayed';
  request_id: string;
  tenant_public_id: string;
  service_public_id: string | null;
}

export async function activateBookingFee(
  input: CommonInput & { amountMinor: number },
): Promise<ConfigurationResult> {
  assertMinor(input.amountMinor);
  return mutate(
    input,
    'activate_booking_fee',
    null,
    { amount_minor: input.amountMinor },
    async (ctx) => {
      const active = ctx.database.collection('tenant_booking_fee_active');
      const current = await active.findOne({ tenant_id: ctx.tenant._id }, { session: ctx.session });
      const now = new Date();
      const version = Number(current?.version ?? 0) + 1;
      const versionId = new ObjectId();
      const publicId = randomUUID();
      await ctx.database.collection('tenant_booking_fee_versions').insertOne(
        {
          _id: versionId,
          public_id: publicId,
          tenant_id: ctx.tenant._id,
          version,
          amount_minor: input.amountMinor,
          currency: 'USD',
          operator_id: input.operatorId,
          reason: input.reason,
          request_id: input.requestId,
          idempotency_key_hash: hash(input.requestId),
          request_fingerprint: ctx.fingerprint,
          created_at: now,
        },
        { session: ctx.session },
      );
      const pointer = {
        _id: current?._id ?? new ObjectId(),
        tenant_id: ctx.tenant._id,
        fee_version_id: versionId,
        fee_version_public_id: publicId,
        version,
        amount_minor: input.amountMinor,
        currency: 'USD',
        activated_at: now,
        activated_by_operator_id: input.operatorId,
        activation_request_id: input.requestId,
      };
      if (current) {
        const updated = await active.replaceOne(
          { _id: current._id, version: current.version },
          pointer,
          { session: ctx.session },
        );
        if (updated.modifiedCount !== 1)
          throw new Error('payment_configuration_concurrency_conflict');
      } else await active.insertOne(pointer, { session: ctx.session });
      return {
        version,
        public_id: publicId,
        enabled: null,
        payment_mode: null,
        amount_minor: input.amountMinor,
      };
    },
  );
}

export async function activateServiceConfiguration(
  input: CommonInput & {
    servicePublicId: string;
    paymentMode: PaymentMode;
    fixedDepositMinor?: number | null;
  },
): Promise<ConfigurationResult> {
  if (!UUID.test(input.servicePublicId)) throw new Error('payment_configuration_service_invalid');
  return mutate(
    input,
    'activate_service_configuration',
    input.servicePublicId,
    { payment_mode: input.paymentMode, fixed_deposit_minor: input.fixedDepositMinor ?? null },
    async (ctx) => {
      const service = await ctx.database
        .collection('services')
        .findOne(
          { tenant_id: ctx.tenant._id, public_id: input.servicePublicId },
          { session: ctx.session },
        );
      if (!service) throw new Error('payment_configuration_service_not_found');
      if (service.currency !== 'USD') throw new Error('payment_configuration_currency_unsupported');
      const normalized = normalizeServicePaymentConfiguration({
        servicePriceMinor: Number(service.base_price_minor),
        paymentMode: input.paymentMode,
        ...(input.fixedDepositMinor === undefined
          ? {}
          : { fixedDepositMinor: input.fixedDepositMinor }),
      });
      const active = ctx.database.collection('service_payment_configuration_active');
      const current = await active.findOne(
        { tenant_id: ctx.tenant._id, service_id: service._id },
        { session: ctx.session },
      );
      const now = new Date();
      const version = Number(current?.version ?? 0) + 1;
      const versionId = new ObjectId();
      const publicId = randomUUID();
      await ctx.database.collection('service_payment_configuration_versions').insertOne(
        {
          _id: versionId,
          public_id: publicId,
          tenant_id: ctx.tenant._id,
          service_id: service._id,
          service_public_id: input.servicePublicId,
          version,
          payment_mode: normalized.paymentMode,
          fixed_deposit_minor: normalized.fixedDepositMinor,
          currency: 'USD',
          request_id: input.requestId,
          idempotency_key_hash: hash(input.requestId),
          request_fingerprint: ctx.fingerprint,
          changed_by_operator_id: input.operatorId,
          created_at: now,
        },
        { session: ctx.session },
      );
      await active.replaceOne(
        { tenant_id: ctx.tenant._id, service_id: service._id },
        {
          tenant_id: ctx.tenant._id,
          service_id: service._id,
          configuration_version_id: versionId,
          configuration_public_id: publicId,
          version,
          payment_mode: normalized.paymentMode,
          fixed_deposit_minor: normalized.fixedDepositMinor,
          currency: 'USD',
          activated_at: now,
          activation_request_id: input.requestId,
        },
        { upsert: true, session: ctx.session },
      );
      return {
        version,
        public_id: publicId,
        enabled: null,
        payment_mode: normalized.paymentMode,
        amount_minor: normalized.fixedDepositMinor,
      };
    },
  );
}

export async function setTenantPaymentExecution(
  input: CommonInput & { enabled: boolean },
): Promise<ConfigurationResult> {
  return mutate(input, 'set_tenant_execution', null, { enabled: input.enabled }, async (ctx) => {
    const now = new Date();
    await ctx.database.collection('tenant_payment_execution_settings').replaceOne(
      { tenant_id: ctx.tenant._id },
      {
        tenant_id: ctx.tenant._id,
        enabled: input.enabled,
        currency: 'USD',
        approved_by_operator_id: input.operatorId,
        approval_request_id: input.requestId,
        updated_at: now,
      },
      { upsert: true, session: ctx.session },
    );
    return {
      version: null,
      public_id: null,
      enabled: input.enabled,
      payment_mode: null,
      amount_minor: null,
    };
  });
}

async function mutate(
  input: CommonInput,
  operationType: OperationType,
  servicePublicId: string | null,
  values: Record<string, unknown>,
  mutation: (context: {
    database: Db;
    session: ClientSession;
    tenant: TenantDocument;
    fingerprint: string;
  }) => Promise<ResultEvidence>,
): Promise<ConfigurationResult> {
  if (!UUID.test(input.requestId)) throw new Error('payment_configuration_request_id_invalid');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(input.tenantSlug))
    throw new Error('payment_configuration_tenant_invalid');
  const fingerprint = hash(
    JSON.stringify({
      schema: 1,
      operation_type: operationType,
      environment: input.environment,
      tenant_slug: input.tenantSlug,
      service_public_id: servicePublicId,
      ...values,
    }),
  );
  const operations = input.database.collection<ConfigurationOperationDocument>(
    'payment_configuration_operations',
  );
  const existing = await operations.findOne({ request_id: input.requestId });
  if (existing) return replay(existing, fingerprint);
  const session = input.database.client.startSession();
  try {
    let completed: ConfigurationResult | undefined;
    try {
      await session.withTransaction(async () => {
        const operation = await operations.findOne({ request_id: input.requestId }, { session });
        if (operation) {
          completed = replay(operation, fingerprint);
          return;
        }
        const tenant = await input.database
          .collection<TenantDocument>('tenants')
          .findOne(
            { slug: input.tenantSlug },
            { session, projection: { public_id: 1, status: 1, currency: 1 } },
          );
        if (!tenant) throw new Error('payment_configuration_tenant_not_found');
        if (tenant.status !== 'active') throw new Error('payment_configuration_tenant_inactive');
        if (tenant.currency !== 'USD')
          throw new Error('payment_configuration_currency_unsupported');
        const result = await mutation({
          database: input.database,
          session,
          tenant,
          fingerprint,
        });
        const now = new Date();
        await operations.insertOne(
          {
            _id: new ObjectId(),
            public_id: randomUUID(),
            request_id: input.requestId,
            operation_type: operationType,
            request_fingerprint: fingerprint,
            operator_id: input.operatorId,
            reason: input.reason,
            environment: input.environment,
            tenant_public_id: tenant.public_id,
            service_public_id: servicePublicId,
            status: 'completed',
            result,
            created_at: now,
            completed_at: now,
          },
          { session },
        );
        await input.database.collection('audit_logs').insertOne(
          {
            public_id: randomUUID(),
            event: `payment_configuration.${operationType}`,
            outcome: 'success',
            actor_user_id: null,
            tenant_id: tenant._id,
            request_id: input.requestId,
            metadata: {
              operator_id: input.operatorId,
              tenant_public_id: tenant.public_id,
              service_public_id: servicePublicId,
              version: result.version === null ? null : String(result.version),
              enabled: result.enabled === null ? null : String(result.enabled),
              payment_mode: result.payment_mode,
              amount_minor: result.amount_minor === null ? null : String(result.amount_minor),
            },
            created_at: now,
          },
          { session },
        );
        completed = response(
          'completed',
          input.requestId,
          tenant.public_id,
          servicePublicId,
          result,
        );
      });
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11_000)) throw error;
      const concurrent = await operations.findOne({ request_id: input.requestId });
      if (!concurrent) throw error;
      completed = replay(concurrent, fingerprint);
    }
    if (!completed) throw new Error('payment_configuration_no_result');
    return completed;
  } finally {
    await session.endSession();
  }
}

function replay(
  operation: ConfigurationOperationDocument,
  fingerprint: string,
): ConfigurationResult {
  if (operation.request_fingerprint !== fingerprint)
    throw new Error('payment_configuration_request_conflict');
  return response(
    'replayed',
    operation.request_id,
    operation.tenant_public_id,
    operation.service_public_id,
    operation.result,
  );
}

function response(
  outcome: 'completed' | 'replayed',
  requestId: string,
  tenantPublicId: string,
  servicePublicId: string | null,
  result: ResultEvidence,
): ConfigurationResult {
  return {
    outcome,
    request_id: requestId,
    tenant_public_id: tenantPublicId,
    service_public_id: servicePublicId,
    ...result,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('payment_configuration_amount_invalid');
}
