import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, type MongoClient, MongoServerError, ObjectId } from 'mongodb';
import type {
  RoleDocument,
  TenantDocument,
  TenantProvisioningOperationDocument,
  UserDocument,
} from '../admin/store.js';
import type { ProvisioningAuthorization } from './guard.js';
import { ProvisioningConflict, ProvisioningPersistenceFailure } from './service.js';

export interface OwnerPasswordResetSelectors {
  tenantId?: string;
  tenantSlug?: string;
  ownerId?: string;
  ownerEmail?: string;
}

export interface OwnerPasswordResetTarget {
  tenantObjectId: ObjectId;
  tenantPublicId: string;
  tenantSlug: string;
  designation: TenantDocument['designation'];
  ownerObjectId: ObjectId;
  ownerPublicId: string;
  ownerEmail: string;
}

export interface OwnerPasswordResetResult {
  outcome: 'completed' | 'replayed';
  request_id: string;
  tenant_public_id: string;
  tenant_slug: string;
  owner_user_public_id: string;
  owner_email: string;
  sessions_revoked: number;
  active_sessions_remaining: number;
  must_change_password: true;
}

export interface OwnerPasswordResetPreparation {
  target: OwnerPasswordResetTarget;
  fingerprint: string;
  replay: OwnerPasswordResetResult | null;
}

interface Hooks {
  beforeCommit?: (stage: 'password' | 'sessions' | 'operation' | 'audit') => void | Promise<void>;
}

export async function prepareOwnerPasswordReset(input: {
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  selectors: OwnerPasswordResetSelectors;
}): Promise<OwnerPasswordResetPreparation> {
  const target = await resolveOwnerPasswordResetTarget(input.database, input.selectors);
  const fingerprint = passwordResetFingerprint(target, input.authorization);
  return {
    target,
    fingerprint,
    replay: await replayOwnerPasswordReset(input.database, input.requestId, fingerprint),
  };
}

export async function resetOwnerPassword(input: {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  preparation: OwnerPasswordResetPreparation;
  passwordHash: string;
  hooks?: Hooks;
}): Promise<OwnerPasswordResetResult> {
  if (input.preparation.replay) return input.preparation.replay;
  const { target, fingerprint } = input.preparation;
  const session = input.client.startSession();
  let result: OwnerPasswordResetResult | undefined;
  try {
    await session.withTransaction(async () => {
      const replay = await replayOwnerPasswordReset(
        input.database,
        input.requestId,
        fingerprint,
        session,
      );
      if (replay) {
        result = replay;
        return;
      }
      await assertTargetStillValid(input.database, target, session);
      const now = new Date();
      const passwordUpdate = await input.database.collection<UserDocument>('users').updateOne(
        { _id: target.ownerObjectId, status: 'active' },
        {
          $set: {
            password_hash: input.passwordHash,
            must_change_password: true,
            updated_at: now,
          },
        },
        { session },
      );
      if (passwordUpdate.matchedCount !== 1) throw new OwnerPasswordResetTargetConflict();
      await input.hooks?.beforeCommit?.('password');

      const revoked = await input.database
        .collection('admin_sessions')
        .updateMany(
          { user_id: target.ownerObjectId, revoked_at: null },
          { $set: { revoked_at: now, revocation_reason: 'operator_password_reset' } },
          { session },
        );
      await input.hooks?.beforeCommit?.('sessions');
      const activeSessionsRemaining = await input.database
        .collection('admin_sessions')
        .countDocuments(
          { user_id: target.ownerObjectId, revoked_at: null, expires_at: { $gt: now } },
          { session },
        );
      if (activeSessionsRemaining !== 0) throw new OwnerPasswordResetVerificationFailure();

      result = {
        outcome: 'completed',
        request_id: input.requestId,
        tenant_public_id: target.tenantPublicId,
        tenant_slug: target.tenantSlug,
        owner_user_public_id: target.ownerPublicId,
        owner_email: target.ownerEmail,
        sessions_revoked: revoked.modifiedCount,
        active_sessions_remaining: activeSessionsRemaining,
        must_change_password: true,
      };
      await insertEvidence(input, result, fingerprint, now, session);
    }, transactionOptions);
  } catch (error) {
    const replay = await replayOwnerPasswordReset(input.database, input.requestId, fingerprint);
    if (replay) return replay;
    if (error instanceof ProvisioningConflict) throw error;
    if (error instanceof OwnerPasswordResetTargetConflict)
      throw new ProvisioningConflict('owner_target_conflict');
    if (error instanceof MongoServerError && error.code === 11000) {
      const concurrentReplay = await replayOwnerPasswordReset(
        input.database,
        input.requestId,
        fingerprint,
      );
      if (concurrentReplay) return concurrentReplay;
    }
    throw new ProvisioningPersistenceFailure('transaction');
  } finally {
    await session.endSession();
  }
  if (!result) throw new ProvisioningPersistenceFailure('transaction');
  return result;
}

export async function resolveOwnerPasswordResetTarget(
  database: Db,
  selectors: OwnerPasswordResetSelectors,
): Promise<OwnerPasswordResetTarget> {
  if (
    (selectors.tenantId === undefined) === (selectors.tenantSlug === undefined) ||
    (selectors.ownerId === undefined) === (selectors.ownerEmail === undefined)
  )
    throw new ProvisioningConflict('owner_target_conflict');
  const tenantQuery = selectors.tenantId
    ? { public_id: selectors.tenantId }
    : { slug: selectors.tenantSlug! };
  const tenants = await database
    .collection<TenantDocument>('tenants')
    .find(tenantQuery)
    .limit(2)
    .toArray();
  if (tenants.length !== 1) throw new ProvisioningConflict('tenant_target_conflict');
  const tenant = tenants[0]!;

  const ownerQuery = selectors.ownerId
    ? { public_id: selectors.ownerId, status: 'active' as const }
    : { email_normalized: selectors.ownerEmail!, status: 'active' as const };
  const owners = await database
    .collection<UserDocument>('users')
    .find(ownerQuery)
    .limit(2)
    .toArray();
  if (owners.length !== 1) throw new ProvisioningConflict('owner_target_conflict');
  const owner = owners[0]!;
  const roles = await database
    .collection<RoleDocument>('roles')
    .find({ tenant_id: tenant._id, user_id: owner._id, role: 'tenant_owner', status: 'active' })
    .limit(2)
    .toArray();
  if (roles.length !== 1) throw new ProvisioningConflict('owner_target_conflict');
  return {
    tenantObjectId: tenant._id,
    tenantPublicId: tenant.public_id,
    tenantSlug: tenant.slug,
    designation: tenant.designation,
    ownerObjectId: owner._id,
    ownerPublicId: owner.public_id,
    ownerEmail: owner.email_normalized,
  };
}

async function assertTargetStillValid(
  database: Db,
  target: OwnerPasswordResetTarget,
  session: ClientSession,
): Promise<void> {
  const [tenant, owner, roles] = await Promise.all([
    database
      .collection<TenantDocument>('tenants')
      .findOne(
        { _id: target.tenantObjectId, public_id: target.tenantPublicId, slug: target.tenantSlug },
        { session },
      ),
    database.collection<UserDocument>('users').findOne(
      {
        _id: target.ownerObjectId,
        public_id: target.ownerPublicId,
        email_normalized: target.ownerEmail,
        status: 'active',
      },
      { session },
    ),
    database.collection<RoleDocument>('roles').countDocuments(
      {
        tenant_id: target.tenantObjectId,
        user_id: target.ownerObjectId,
        role: 'tenant_owner',
        status: 'active',
      },
      { session },
    ),
  ]);
  if (!tenant || !owner || roles !== 1) throw new OwnerPasswordResetTargetConflict();
}

async function insertEvidence(
  input: Parameters<typeof resetOwnerPassword>[0],
  result: OwnerPasswordResetResult,
  fingerprint: string,
  now: Date,
  session: ClientSession,
): Promise<void> {
  const target = input.preparation.target;
  await input.database
    .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
    .insertOne(
      {
        _id: new ObjectId(),
        public_id: randomUUID(),
        request_id: input.requestId,
        operation_type: 'reset_owner_password',
        request_fingerprint: fingerprint,
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
        tenant_public_id: target.tenantPublicId,
        owner_user_public_id: target.ownerPublicId,
        designation: target.designation,
        status: 'completed',
        failure_category: null,
        created_at: now,
        completed_at: now,
      },
      { session },
    );
  await input.hooks?.beforeCommit?.('operation');
  await input.database.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event: 'owner_password_reset',
      outcome: 'success',
      actor_user_id: null,
      tenant_id: target.tenantObjectId,
      request_id: input.requestId,
      metadata: {
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
        tenant_public_id: target.tenantPublicId,
        tenant_slug: target.tenantSlug,
        owner_user_public_id: target.ownerPublicId,
        owner_email_normalized: target.ownerEmail,
        sessions_revoked: String(result.sessions_revoked),
        active_sessions_remaining: String(result.active_sessions_remaining),
        must_change_password: 'true',
        operation_outcome: result.outcome,
      },
      created_at: now,
    },
    { session },
  );
  await input.hooks?.beforeCommit?.('audit');
}

async function replayOwnerPasswordReset(
  database: Db,
  requestId: string,
  fingerprint: string,
  session?: ClientSession,
): Promise<OwnerPasswordResetResult | null> {
  const option = session ? { session } : undefined;
  const operation = await database
    .collection<TenantProvisioningOperationDocument>('tenant_provisioning_operations')
    .findOne({ request_id: requestId }, option);
  if (!operation) return null;
  if (operation.request_fingerprint !== fingerprint)
    throw new ProvisioningConflict('request_id_mismatch');
  if (operation.operation_type !== 'reset_owner_password' || operation.status !== 'completed')
    throw new ProvisioningConflict('request_id_mismatch');
  const audit = await database.collection('audit_logs').findOne({ request_id: requestId }, option);
  if (!audit || audit.event !== 'owner_password_reset' || audit.outcome !== 'success') return null;
  const metadata = audit.metadata as Record<string, string | undefined>;
  if (!metadata.owner_email_normalized) throw new ProvisioningConflict('request_id_mismatch');
  return {
    outcome: 'replayed',
    request_id: requestId,
    tenant_public_id: operation.tenant_public_id!,
    tenant_slug: metadata.tenant_slug ?? '',
    owner_user_public_id: operation.owner_user_public_id!,
    owner_email: metadata.owner_email_normalized,
    sessions_revoked: Number(metadata.sessions_revoked ?? 0),
    active_sessions_remaining: Number(metadata.active_sessions_remaining ?? 0),
    must_change_password: true,
  };
}

function passwordResetFingerprint(
  target: OwnerPasswordResetTarget,
  authorization: ProvisioningAuthorization,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation_type: 'reset_owner_password',
        tenant_public_id: target.tenantPublicId,
        owner_user_public_id: target.ownerPublicId,
        operator_id: authorization.operatorId,
        reason: authorization.reason,
      }),
    )
    .digest('hex');
}

const transactionOptions = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
};

class OwnerPasswordResetTargetConflict extends Error {}
class OwnerPasswordResetVerificationFailure extends Error {}
