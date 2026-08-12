import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, type MongoClient, ObjectId } from 'mongodb';
import type {
  RoleDocument,
  TenantDocument,
  TenantProvisioningOperationDocument,
} from '../admin/store.js';
import type { ProvisioningAuthorization } from './guard.js';
import { ProvisioningConflict, ProvisioningPersistenceFailure } from './service.js';

const PROCESSING_STALE_MILLISECONDS = 300_000;

export type TenantStatus = 'active' | 'suspended';

export interface StatusVerificationCounts {
  active_appointments: number;
  active_tokens: number;
  active_sessions: number;
  pending_or_processing_outbox: number;
}

export interface StatusResult {
  outcome: 'completed' | 'replayed' | 'refused';
  request_id: string;
  tenant_public_id: string;
  status: TenantStatus;
  roles_suspended: number;
  roles_restored: number;
  sessions_revoked: number;
  tokens_revoked: number;
  outbox_failed: number;
  verification: StatusVerificationCounts;
  failure_category: string | null;
}

export class ProvisioningCleanupRefused extends Error {
  public constructor(
    public readonly result: StatusResult,
    public readonly code: 'active_appointments_remain' | 'cleanup_verification_failed',
  ) {
    super(`Internal QA cleanup refused: ${code}`);
  }
}

export async function setTenantStatus(input: {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  tenantSlug: string;
  status: TenantStatus;
}): Promise<StatusResult> {
  return runStatusOperation({ ...input, operationType: 'set_status' });
}

export async function deactivateInternalQa(input: {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  tenantSlug: string;
}): Promise<StatusResult> {
  return runStatusOperation({
    ...input,
    operationType: 'deactivate_internal_qa',
    status: 'suspended',
  });
}

async function runStatusOperation(input: {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  tenantSlug: string;
  status: TenantStatus;
  operationType: 'set_status' | 'deactivate_internal_qa';
}): Promise<StatusResult> {
  const fingerprint = statusFingerprint(input);
  const replay = await replayStatusResult(input.database, input.requestId, fingerprint);
  if (replay) return replay;
  const tenant = await input.database
    .collection<TenantDocument>('tenants')
    .findOne({ slug: input.tenantSlug });
  if (!tenant) throw new ProvisioningConflict('tenant_slug_conflict');
  if (input.operationType === 'deactivate_internal_qa' && tenant.designation !== 'internal_qa')
    throw new ProvisioningConflict('tenant_designation_conflict');

  if (input.operationType === 'deactivate_internal_qa') {
    const activeAppointments = await input.database.collection('appointments').countDocuments({
      tenant_id: tenant._id,
      status: 'scheduled',
    });
    if (activeAppointments > 0)
      return persistRefusal(input, tenant, fingerprint, 'active_appointments_remain');
  }

  const session = input.client.startSession();
  let result: StatusResult | undefined;
  try {
    await session.withTransaction(async () => {
      const current = await input.database
        .collection<TenantDocument>('tenants')
        .findOne({ _id: tenant._id }, { session });
      if (!current) throw new ProvisioningConflict('tenant_slug_conflict');
      if (input.operationType === 'deactivate_internal_qa' && current.designation !== 'internal_qa')
        throw new ProvisioningConflict('tenant_designation_conflict');
      if (
        input.operationType === 'deactivate_internal_qa' &&
        (await input.database
          .collection('appointments')
          .countDocuments({ tenant_id: current._id, status: 'scheduled' }, { session })) > 0
      )
        throw new CleanupRaceError();

      const now = new Date();
      const roles = input.database.collection<RoleDocument>('roles');
      let rolesSuspended = 0;
      let rolesRestored = 0;
      let sessionsRevoked = 0;
      let tokensRevoked = 0;
      let outboxFailed = 0;

      if (input.status === 'suspended') {
        const roleResult = await roles.updateMany(
          { tenant_id: current._id, status: 'active' },
          { $set: { status: 'suspended', suspended_by_tenant_status: true, updated_at: now } },
          { session },
        );
        rolesSuspended = roleResult.modifiedCount;
        const roleIds = await roles.distinct('_id', { tenant_id: current._id }, { session });
        const sessionResult = await input.database.collection('admin_sessions').updateMany(
          {
            selected_membership_id: { $in: roleIds },
            revoked_at: null,
            expires_at: { $gt: now },
          },
          { $set: { revoked_at: now, revocation_reason: 'tenant_suspended' } },
          { session },
        );
        sessionsRevoked = sessionResult.modifiedCount;
        const tokenResult = await input.database
          .collection('appointment_public_access_tokens')
          .updateMany(
            { tenant_id: current._id, status: 'active' },
            { $set: { status: 'revoked', revoked_at: now, updated_at: now } },
            { session },
          );
        tokensRevoked = tokenResult.modifiedCount;
      } else {
        const roleResult = await roles.updateMany(
          { tenant_id: current._id, status: 'suspended', suspended_by_tenant_status: true },
          {
            $set: { status: 'active', updated_at: now },
            $unset: { suspended_by_tenant_status: '' },
          },
          { session },
        );
        rolesRestored = roleResult.modifiedCount;
      }

      const tenantSet: Record<string, unknown> = {
        status: input.status,
        public_booking_enabled: false,
        updated_at: now,
      };
      if (input.operationType === 'deactivate_internal_qa') {
        tenantSet['appointment_email_settings.enabled'] = false;
        tenantSet['appointment_self_service.enabled'] = false;
        const staleBefore = new Date(now.valueOf() - PROCESSING_STALE_MILLISECONDS);
        const outboxResult = await input.database.collection('notification_outbox').updateMany(
          {
            tenant_id: current._id,
            $or: [
              { status: 'pending' },
              { status: 'processing', processing_started_at: { $lte: staleBefore } },
            ],
          },
          {
            $set: {
              status: 'failed',
              failed_at: now,
              processing_started_at: null,
              last_error_code: 'internal_qa_deactivated',
              updated_at: now,
            },
          },
          { session },
        );
        outboxFailed = outboxResult.modifiedCount;
      }
      await input.database
        .collection<TenantDocument>('tenants')
        .updateOne({ _id: current._id }, { $set: tenantSet, $inc: { version: 1 } }, { session });

      const verification = await verificationCounts(input.database, current._id, session);
      if (
        input.operationType === 'deactivate_internal_qa' &&
        Object.values(verification).some((count) => count > 0)
      )
        throw new CleanupVerificationError(verification);

      result = {
        outcome: 'completed',
        request_id: input.requestId,
        tenant_public_id: current.public_id,
        status: input.status,
        roles_suspended: rolesSuspended,
        roles_restored: rolesRestored,
        sessions_revoked: sessionsRevoked,
        tokens_revoked: tokensRevoked,
        outbox_failed: outboxFailed,
        verification,
        failure_category: null,
      };
      await insertEvidence(input, current, fingerprint, result, session, 'success');
    }, transactionOptions);
  } catch (error) {
    const recovered = await replayStatusResult(input.database, input.requestId, fingerprint);
    if (recovered) return recovered;
    if (error instanceof CleanupRaceError || error instanceof CleanupVerificationError)
      return persistRefusal(
        input,
        tenant,
        fingerprint,
        error instanceof CleanupRaceError
          ? 'active_appointments_remain'
          : 'cleanup_verification_failed',
      );
    if (error instanceof ProvisioningConflict) throw error;
    throw new ProvisioningPersistenceFailure('transaction');
  } finally {
    await session.endSession();
  }
  if (!result) throw new ProvisioningPersistenceFailure('transaction');
  return result;
}

async function persistRefusal(
  input: Parameters<typeof runStatusOperation>[0],
  tenant: TenantDocument,
  fingerprint: string,
  category: 'active_appointments_remain' | 'cleanup_verification_failed',
): Promise<StatusResult> {
  const session = input.client.startSession();
  let result: StatusResult | undefined;
  try {
    await session.withTransaction(async () => {
      const replay = await replayStatusResult(
        input.database,
        input.requestId,
        fingerprint,
        session,
      );
      if (replay) {
        result = replay;
        return;
      }
      const verification = await verificationCounts(input.database, tenant._id, session);
      result = {
        outcome: 'refused',
        request_id: input.requestId,
        tenant_public_id: tenant.public_id,
        status: tenant.status,
        roles_suspended: 0,
        roles_restored: 0,
        sessions_revoked: 0,
        tokens_revoked: 0,
        outbox_failed: 0,
        verification,
        failure_category: category,
      };
      await insertEvidence(input, tenant, fingerprint, result, session, 'failure');
    }, transactionOptions);
  } finally {
    await session.endSession();
  }
  if (!result) throw new ProvisioningPersistenceFailure('transaction');
  return result;
}

async function insertEvidence(
  input: Parameters<typeof runStatusOperation>[0],
  tenant: TenantDocument,
  fingerprint: string,
  result: StatusResult,
  session: ClientSession,
  outcome: 'success' | 'failure',
) {
  const now = new Date();
  await input.database
    .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
    .insertOne(
      {
        _id: new ObjectId(),
        public_id: randomUUID(),
        request_id: input.requestId,
        operation_type: input.operationType,
        request_fingerprint: fingerprint,
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
        tenant_public_id: tenant.public_id,
        owner_user_public_id: null,
        designation: tenant.designation,
        status: outcome === 'success' ? 'completed' : 'failed',
        failure_category: result.failure_category,
        created_at: now,
        completed_at: now,
      },
      { session },
    );
  await input.database.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event:
        input.operationType === 'set_status'
          ? 'tenant_status_changed'
          : `internal_qa_cleanup_${outcome === 'success' ? 'succeeded' : 'failed'}`,
      outcome,
      actor_user_id: null,
      tenant_id: tenant._id,
      request_id: input.requestId,
      metadata: {
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
        designation: tenant.designation,
        tenant_public_id: tenant.public_id,
        previous_state: tenant.status,
        new_state: result.status,
        active_appointments: String(result.verification.active_appointments),
        active_tokens: String(result.verification.active_tokens),
        active_sessions: String(result.verification.active_sessions),
        pending_or_processing_outbox: String(result.verification.pending_or_processing_outbox),
        operation_outcome: result.outcome,
        roles_suspended: String(result.roles_suspended),
        roles_restored: String(result.roles_restored),
        sessions_revoked: String(result.sessions_revoked),
        tokens_revoked: String(result.tokens_revoked),
        outbox_failed: String(result.outbox_failed),
        failure_category: result.failure_category,
      },
      created_at: now,
    },
    { session },
  );
}

async function replayStatusResult(
  db: Db,
  requestId: string,
  fingerprint: string,
  session?: ClientSession,
): Promise<StatusResult | null> {
  const operation = await db
    .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
    .findOne({ request_id: requestId }, session ? { session } : undefined);
  if (!operation) return null;
  if (operation.request_fingerprint !== fingerprint)
    throw new ProvisioningConflict('request_id_mismatch');
  const audit = await db
    .collection('audit_logs')
    .findOne({ request_id: requestId }, session ? { session } : undefined);
  if (!audit) return null;
  const metadata = audit.metadata as Record<string, string | null>;
  return {
    outcome: metadata.operation_outcome === 'refused' ? 'refused' : 'replayed',
    request_id: requestId,
    tenant_public_id: operation.tenant_public_id!,
    status: (metadata.new_state ?? metadata.previous_state) as TenantStatus,
    roles_suspended: Number(metadata.roles_suspended ?? 0),
    roles_restored: Number(metadata.roles_restored ?? 0),
    sessions_revoked: Number(metadata.sessions_revoked ?? 0),
    tokens_revoked: Number(metadata.tokens_revoked ?? 0),
    outbox_failed: Number(metadata.outbox_failed ?? 0),
    verification: {
      active_appointments: Number(metadata.active_appointments ?? 0),
      active_tokens: Number(metadata.active_tokens ?? 0),
      active_sessions: Number(metadata.active_sessions ?? 0),
      pending_or_processing_outbox: Number(metadata.pending_or_processing_outbox ?? 0),
    },
    failure_category: operation.failure_category,
  };
}

async function verificationCounts(
  db: Db,
  tenantId: ObjectId,
  session?: ClientSession,
): Promise<StatusVerificationCounts> {
  const options = session ? { session } : undefined;
  const roleIds = await db
    .collection('roles')
    .distinct('_id', { tenant_id: tenantId }, session ? { session } : {});
  const now = new Date();
  const [activeAppointments, activeTokens, activeSessions, outbox] = await Promise.all([
    db
      .collection('appointments')
      .countDocuments({ tenant_id: tenantId, status: 'scheduled' }, options),
    db
      .collection('appointment_public_access_tokens')
      .countDocuments({ tenant_id: tenantId, status: 'active' }, options),
    db
      .collection('admin_sessions')
      .countDocuments(
        { selected_membership_id: { $in: roleIds }, revoked_at: null, expires_at: { $gt: now } },
        options,
      ),
    db
      .collection('notification_outbox')
      .countDocuments({ tenant_id: tenantId, status: { $in: ['pending', 'processing'] } }, options),
  ]);
  return {
    active_appointments: activeAppointments,
    active_tokens: activeTokens,
    active_sessions: activeSessions,
    pending_or_processing_outbox: outbox,
  };
}

function statusFingerprint(input: Parameters<typeof runStatusOperation>[0]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation_type: input.operationType,
        tenant: input.tenantSlug,
        status: input.status,
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
      }),
    )
    .digest('hex');
}

const transactionOptions = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
};
class CleanupRaceError extends Error {}
class CleanupVerificationError extends Error {
  public constructor(public readonly counts: StatusVerificationCounts) {
    super('Cleanup verification failed');
  }
}
