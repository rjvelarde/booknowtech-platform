import { randomUUID } from 'node:crypto';
import { PLATFORM_TENANT_DEFAULTS } from '@booknowtech/shared';
import { type ClientSession, type Db, type MongoClient, MongoServerError, ObjectId } from 'mongodb';
import type {
  RoleDocument,
  TenantDocument,
  TenantProvisioningOperationDocument,
  UserDocument,
} from '../admin/store.js';
import type { ProvisioningAuthorization } from './guard.js';
import { type ValidatedProvisioningInput, fingerprintProvisioningRequest } from './input.js';

export type ProvisioningConflictCode =
  'request_id_mismatch' | 'tenant_slug_conflict' | 'owner_email_conflict';

export class ProvisioningConflict extends Error {
  public constructor(public readonly code: ProvisioningConflictCode) {
    super(`Provisioning conflict: ${code}`);
  }
}

/**
 * A deliberately redacted persistence failure. The CLI may report the stage
 * identifier, but never a database error message because those messages can
 * contain document fragments.
 */
export class ProvisioningPersistenceFailure extends Error {
  public constructor(
    public readonly stage:
      | 'conflict_check'
      | 'tenant_insert'
      | 'owner_insert'
      | 'role_insert'
      | 'operation_insert'
      | 'audit_insert'
      | 'transaction',
  ) {
    super(`Provisioning persistence failed at ${stage}`);
  }
}

export interface ProvisioningResult {
  outcome: 'created' | 'replayed';
  request_id: string;
  tenant_public_id: string;
  owner_user_public_id: string;
  fallback_hostname: string;
}

interface Hooks {
  beforeCommit?: (stage: string) => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
}

export async function provisionTenant(input: {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  provisioningInput: ValidatedProvisioningInput;
  passwordHash: string;
  hooks?: Hooks;
}): Promise<ProvisioningResult> {
  const fingerprint = fingerprintProvisioningRequest(input.provisioningInput, input.authorization);
  const existing = await replayResult(
    input.database,
    input.requestId,
    fingerprint,
    input.provisioningInput.fallback_hostname,
  );
  if (existing) return existing;

  const tenantId = new ObjectId();
  const userId = new ObjectId();
  const roleId = new ObjectId();
  const tenantPublicId = randomUUID();
  const ownerPublicId = randomUUID();
  const now = new Date();
  let persistenceStage: ProvisioningPersistenceFailure['stage'] = 'transaction';

  try {
    const session = input.client.startSession();
    try {
      await session.withTransaction(
        async () => {
          persistenceStage = 'conflict_check';
          await assertNoConflicts(input.database, input.provisioningInput, session);
          const tenant = buildTenant(input.provisioningInput, tenantId, tenantPublicId, now);
          const user: UserDocument = {
            _id: userId,
            public_id: ownerPublicId,
            email_normalized: input.provisioningInput.owner.email,
            display_name: input.provisioningInput.owner.display_name,
            password_hash: input.passwordHash,
            must_change_password: true,
            status: 'active',
            created_at: now,
            updated_at: now,
          };
          const role: RoleDocument = {
            _id: roleId,
            public_id: randomUUID(),
            tenant_id: tenantId,
            user_id: userId,
            role: 'tenant_owner',
            status: 'active',
            created_at: now,
            updated_at: now,
          };
          const operation: TenantProvisioningOperationDocument = {
            _id: new ObjectId(),
            public_id: randomUUID(),
            request_id: input.requestId,
            operation_type: 'create_tenant',
            request_fingerprint: fingerprint,
            operator_id: input.authorization.operatorId,
            reason: input.authorization.reason,
            tenant_public_id: tenantPublicId,
            owner_user_public_id: ownerPublicId,
            designation: input.provisioningInput.designation,
            status: 'completed',
            failure_category: null,
            created_at: now,
            completed_at: now,
          };

          persistenceStage = 'tenant_insert';
          await input.database.collection<TenantDocument>('tenants').insertOne(tenant, { session });
          await input.hooks?.beforeCommit?.('tenant');
          persistenceStage = 'owner_insert';
          await input.database.collection<UserDocument>('users').insertOne(user, { session });
          await input.hooks?.beforeCommit?.('owner');
          persistenceStage = 'role_insert';
          await input.database.collection<RoleDocument>('roles').insertOne(role, { session });
          await input.hooks?.beforeCommit?.('role');
          persistenceStage = 'operation_insert';
          await input.database
            .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
            .insertOne(operation, { session });
          await input.hooks?.beforeCommit?.('operation');
          persistenceStage = 'audit_insert';
          await input.database.collection('audit_logs').insertOne(
            {
              public_id: randomUUID(),
              event: 'tenant.provisioned',
              outcome: 'success',
              actor_user_id: null,
              tenant_id: tenantId,
              request_id: input.requestId,
              metadata: {
                operator_id: input.authorization.operatorId,
                reason: input.authorization.reason,
                designation: input.provisioningInput.designation,
                tenant_public_id: tenantPublicId,
                owner_user_public_id: ownerPublicId,
              },
              created_at: now,
            },
            { session },
          );
          await input.hooks?.beforeCommit?.('audit');
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
    } finally {
      await session.endSession();
    }
  } catch (error) {
    const replay = await replayResult(
      input.database,
      input.requestId,
      fingerprint,
      input.provisioningInput.fallback_hostname,
    );
    if (replay) return replay;
    if (error instanceof ProvisioningConflict) throw error;
    if (error instanceof MongoServerError && error.code === 11000) {
      await throwResolvedDuplicate(input.database, input.provisioningInput);
    }
    if (error instanceof MongoServerError)
      throw new ProvisioningPersistenceFailure(persistenceStage);
    throw error;
  }

  await input.hooks?.afterCommit?.();
  return {
    outcome: 'created',
    request_id: input.requestId,
    tenant_public_id: tenantPublicId,
    owner_user_public_id: ownerPublicId,
    fallback_hostname: input.provisioningInput.fallback_hostname,
  };
}

async function replayResult(
  db: Db,
  requestId: string,
  fingerprint: string,
  fallbackHostname: string,
): Promise<ProvisioningResult | null> {
  const operation = await db
    .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
    .findOne({ request_id: requestId });
  if (!operation) return null;
  if (operation.request_fingerprint !== fingerprint)
    throw new ProvisioningConflict('request_id_mismatch');
  if (
    operation.status !== 'completed' ||
    !operation.tenant_public_id ||
    !operation.owner_user_public_id
  )
    return null;
  return {
    outcome: 'replayed',
    request_id: requestId,
    tenant_public_id: operation.tenant_public_id,
    owner_user_public_id: operation.owner_user_public_id,
    fallback_hostname: fallbackHostname,
  };
}

async function assertNoConflicts(
  db: Db,
  input: ValidatedProvisioningInput,
  session: ClientSession,
) {
  if (await db.collection('tenants').findOne({ slug: input.slug }, { session }))
    throw new ProvisioningConflict('tenant_slug_conflict');
  if (await db.collection('users').findOne({ email_normalized: input.owner.email }, { session }))
    throw new ProvisioningConflict('owner_email_conflict');
}

async function throwResolvedDuplicate(db: Db, input: ValidatedProvisioningInput): Promise<never> {
  if (await db.collection('tenants').findOne({ slug: input.slug }))
    throw new ProvisioningConflict('tenant_slug_conflict');
  if (await db.collection('users').findOne({ email_normalized: input.owner.email }))
    throw new ProvisioningConflict('owner_email_conflict');
  throw new Error('Provisioning transaction conflict');
}

function buildTenant(
  input: ValidatedProvisioningInput,
  id: ObjectId,
  publicId: string,
  now: Date,
): TenantDocument {
  return {
    _id: id,
    public_id: publicId,
    slug: input.slug,
    display_name: input.business_name,
    legal_name: input.legal_name,
    contact: {
      email_normalized: input.contact.email,
      phone_e164: input.contact.phone_e164,
      website_url: input.contact.website_url,
    },
    default_timezone: input.timezone,
    default_slot_cadence_minutes: PLATFORM_TENANT_DEFAULTS.defaultSlotCadenceMinutes,
    locale: PLATFORM_TENANT_DEFAULTS.locale,
    currency: input.currency,
    designation: input.designation,
    public_booking_enabled: false,
    public_profile: {
      business_name: input.business_name,
      description: null,
      tagline: null,
      logo_url: null,
      primary_color: null,
      website_url: null,
      phone_e164: null,
      email_normalized: null,
    },
    booking_policy: {
      minimum_lead_minutes: PLATFORM_TENANT_DEFAULTS.bookingPolicy.minimumLeadMinutes,
      maximum_advance_days: PLATFORM_TENANT_DEFAULTS.bookingPolicy.maximumAdvanceDays,
    },
    public_booking_terms: {
      version: PLATFORM_TENANT_DEFAULTS.publicBookingTerms.version,
      acknowledgment_label: PLATFORM_TENANT_DEFAULTS.publicBookingTerms.acknowledgmentLabel,
      terms_url: null,
    },
    appointment_email_settings: {
      enabled: false,
      sender_name: input.business_name,
      reply_to_email: null,
    },
    appointment_self_service: {
      enabled: false,
      cancellation_cutoff_minutes:
        PLATFORM_TENANT_DEFAULTS.appointmentSelfService.cancellationCutoffMinutes,
      reschedule_cutoff_minutes:
        PLATFORM_TENANT_DEFAULTS.appointmentSelfService.rescheduleCutoffMinutes,
    },
    version: 1,
    updated_by: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
}
