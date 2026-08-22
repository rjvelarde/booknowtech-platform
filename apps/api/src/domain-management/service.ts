import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type ClientSession, type Db, type MongoClient, MongoServerError, ObjectId } from 'mongodb';
import type {
  BookingHostnameOperationType,
  BookingHostnameStatus,
  TenantBookingHostnameDocument,
  TenantBookingHostnameOperationDocument,
  TenantDocument,
} from '../admin/store.js';
import type { ProvisioningAuthorization } from '../provisioning/guard.js';
import { type DnsTxtResolver, observeTxt } from './dns.js';
import { validateCustomBookingHostname } from './hostname.js';

const CHALLENGE_TTL_MS = 72 * 60 * 60 * 1_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const transactionOptions = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
};

export type DomainFailure =
  | 'dns_record_not_found'
  | 'dns_challenge_mismatch'
  | 'dns_lookup_temporary_failure'
  | 'verification_challenge_expired'
  | 'invalid_transition'
  | 'activation_evidence_incomplete'
  | 'active_hostname_conflict'
  | 'stale_verification_attempt';

export interface DomainResult {
  outcome: 'completed' | 'replayed' | 'refused' | 'failed';
  request_id: string;
  hostname_public_id: string | null;
  tenant_public_id: string | null;
  normalized_hostname: string;
  environment: 'staging' | 'production';
  state: BookingHostnameStatus | null;
  failure_category: string | null;
  txt_record_name: string | null;
  challenge_token?: string;
  challenge_token_available?: false;
  operator_attested_railway_mapping_reference: string | null;
  operator_attested_railway_status: string | null;
  operator_attested_tls_status: string | null;
}

export class DomainManagementConflict extends Error {
  public constructor(
    public readonly code:
      | 'invalid_hostname'
      | 'hostname_conflict'
      | 'tenant_not_found'
      | 'request_id_mismatch'
      | 'hostname_not_found',
  ) {
    super(`Domain management conflict: ${code}`);
  }
}

interface CommonInput {
  client: MongoClient;
  database: Db;
  authorization: ProvisioningAuthorization;
  requestId: string;
  hostname: string;
  now?: () => Date;
  beforeCommit?: (stage: 'hostname' | 'operation' | 'audit') => void | Promise<void>;
}

export async function issueChallenge(
  input: CommonInput & { tenantSlug: string; entropy?: (size: number) => Buffer },
): Promise<DomainResult> {
  const hostname = requireHostname(input);
  const tenant = await input.database
    .collection<TenantDocument>('tenants')
    .findOne({ slug: input.tenantSlug });
  if (!tenant) throw new DomainManagementConflict('tenant_not_found');
  const requestHash = requestFingerprint(input, 'issue_challenge', {
    tenant_public_id: tenant.public_id,
  });
  const replay = await replayResult(input.database, input.requestId, requestHash);
  if (replay) return { ...replay, challenge_token_available: false };
  const token = (input.entropy ?? randomBytes)(32).toString('base64url');
  if (!TOKEN.test(token)) throw new Error('Domain challenge entropy generation failed');
  const challengeHash = boundChallengeHash(input, tenant.public_id, hostname, token);
  const now = (input.now ?? (() => new Date()))();
  const session = input.client.startSession();
  let result: DomainResult | undefined;
  try {
    await session.withTransaction(async () => {
      const collection = input.database.collection<TenantBookingHostnameDocument>(
        'tenant_booking_hostnames',
      );
      const existing = await collection.findOne(
        { environment: environment(input), normalized_hostname: hostname },
        { session },
      );
      if (
        existing &&
        (!existing.tenant_id.equals(tenant._id) || existing.tenant_public_id !== tenant.public_id)
      )
        throw new DomainManagementConflict('hostname_conflict');
      if (existing && ['provisioning', 'active', 'removing'].includes(existing.status)) {
        result = await persistEvidence(
          input,
          session,
          requestHash,
          'issue_challenge',
          existing,
          existing.status,
          'refused',
          'invalid_transition',
          { txt: txtName(hostname) },
        );
        return;
      }
      const document: TenantBookingHostnameDocument = existing
        ? { ...existing }
        : {
            _id: new ObjectId(),
            public_id: randomUUID(),
            tenant_id: tenant._id,
            tenant_public_id: tenant.public_id,
            normalized_hostname: hostname,
            type: 'custom',
            environment: environment(input),
            status: 'pending_verification',
            verification_challenge_hash: null,
            verification_expires_at: null,
            verified_at: null,
            railway_mapping_reference: null,
            railway_status: null,
            tls_status: null,
            last_checked_at: null,
            failure_code: null,
            created_at: now,
            created_by: input.authorization.operatorId,
            updated_at: now,
            updated_by: input.authorization.operatorId,
            activated_at: null,
            disabled_at: null,
            removed_at: null,
          };
      const previous = existing?.status ?? null;
      Object.assign(document, {
        status: 'pending_verification',
        verification_challenge_hash: challengeHash,
        verification_expires_at: new Date(now.valueOf() + CHALLENGE_TTL_MS),
        verified_at: null,
        last_checked_at: null,
        failure_code: null,
        updated_at: now,
        updated_by: input.authorization.operatorId,
        removed_at: null,
        railway_mapping_reference: null,
        railway_status: null,
        tls_status: null,
      });
      if (existing) {
        const replaced = await collection.replaceOne(
          { _id: existing._id, status: existing.status },
          document,
          {
            session,
          },
        );
        if (replaced.matchedCount !== 1) throw new Error('Domain challenge write conflict');
      } else await collection.insertOne(document, { session });
      await input.beforeCommit?.('hostname');
      result = await persistEvidence(
        input,
        session,
        requestHash,
        'issue_challenge',
        document,
        previous,
        'completed',
        null,
        { txt: txtName(hostname) },
      );
    }, transactionOptions);
  } catch (error) {
    const recovered = await replayResult(input.database, input.requestId, requestHash);
    if (recovered) return { ...recovered, challenge_token_available: false };
    throw error;
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Domain challenge transaction returned no result');
  return result.outcome === 'completed' ? { ...result, challenge_token: token } : result;
}

export async function verifyDomain(
  input: CommonInput & { resolver: DnsTxtResolver },
): Promise<DomainResult> {
  const hostname = requireHostname(input);
  const requestHash = requestFingerprint(input, 'verify', {});
  const replay = await replayResult(input.database, input.requestId, requestHash);
  if (replay) return replay;
  const observed = await input.database
    .collection<TenantBookingHostnameDocument>('tenant_booking_hostnames')
    .findOne({ environment: environment(input), normalized_hostname: hostname });
  if (!observed) throw new DomainManagementConflict('hostname_not_found');
  const now = (input.now ?? (() => new Date()))();
  let failure: DomainFailure | null = null;
  let nextState: BookingHostnameStatus = observed.status;
  if (
    observed.status !== 'pending_verification' ||
    !observed.verification_challenge_hash ||
    !observed.verification_expires_at
  )
    failure = 'invalid_transition';
  else if (observed.verification_expires_at <= now) {
    failure = 'verification_challenge_expired';
    nextState = 'failed';
  } else {
    const dns = await observeTxt(input.resolver, txtName(hostname));
    if (dns.kind === 'not_found') failure = 'dns_record_not_found';
    else if (dns.kind === 'temporary_failure') failure = 'dns_lookup_temporary_failure';
    else if (!dns.values.some((value) => challengeMatches(input, observed, value)))
      failure = 'dns_challenge_mismatch';
    else nextState = 'verified';
  }
  const session = input.client.startSession();
  let result: DomainResult | undefined;
  try {
    await session.withTransaction(async () => {
      const collection = input.database.collection<TenantBookingHostnameDocument>(
        'tenant_booking_hostnames',
      );
      const current = await collection.findOne({ _id: observed._id }, { session });
      if (
        !current ||
        current.public_id !== observed.public_id ||
        !current.tenant_id.equals(observed.tenant_id) ||
        current.tenant_public_id !== observed.tenant_public_id ||
        current.environment !== observed.environment ||
        current.normalized_hostname !== observed.normalized_hostname ||
        current.type !== observed.type ||
        current.status !== observed.status ||
        current.verification_challenge_hash !== observed.verification_challenge_hash ||
        current.verification_expires_at?.valueOf() !== observed.verification_expires_at?.valueOf()
      ) {
        const stable = current ?? observed;
        result = await persistEvidence(
          input,
          session,
          requestHash,
          'verify',
          stable,
          stable.status,
          'refused',
          'stale_verification_attempt',
          { txt: txtName(hostname) },
        );
        return;
      }
      const outcome =
        failure === null
          ? 'completed'
          : failure === 'verification_challenge_expired'
            ? 'failed'
            : 'failed';
      if (failure === 'invalid_transition') {
        result = await persistEvidence(
          input,
          session,
          requestHash,
          'verify',
          current,
          current.status,
          'refused',
          failure,
          { txt: txtName(hostname) },
        );
        return;
      }
      const updatedHostname = await collection.updateOne(
        { _id: current._id },
        {
          $set: {
            status: nextState,
            verified_at: failure === null ? now : current.verified_at,
            verification_expires_at: failure === null ? null : current.verification_expires_at,
            last_checked_at: now,
            failure_code: failure,
            updated_at: now,
            updated_by: input.authorization.operatorId,
          },
        },
        { session },
      );
      if (updatedHostname.matchedCount !== 1) throw new Error('Domain verification write conflict');
      await input.beforeCommit?.('hostname');
      const updated = {
        ...current,
        status: nextState,
        verified_at: failure === null ? now : current.verified_at,
        verification_expires_at: failure === null ? null : current.verification_expires_at,
        last_checked_at: now,
        failure_code: failure,
      };
      result = await persistEvidence(
        input,
        session,
        requestHash,
        'verify',
        updated,
        current.status,
        outcome,
        failure,
        { txt: txtName(hostname) },
      );
    }, transactionOptions);
  } catch (error) {
    const recovered = await replayResult(input.database, input.requestId, requestHash);
    if (recovered) return recovered;
    throw error;
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Domain verification transaction returned no result');
  return result;
}

async function persistConcurrentActivationRefusal(
  input: Parameters<typeof transitionDomain>[0],
  requestHash: string,
  evidence: {
    railway_mapping_reference: string | null;
    railway_status: string | null;
    tls_status: string | null;
  },
): Promise<DomainResult> {
  const session = input.client.startSession();
  let result: DomainResult | undefined;
  try {
    await session.withTransaction(async () => {
      const replay = await replayResult(input.database, input.requestId, requestHash, session);
      if (replay) {
        result = replay;
        return;
      }
      const hostname = await input.database
        .collection<TenantBookingHostnameDocument>('tenant_booking_hostnames')
        .findOne(
          {
            environment: environment(input),
            normalized_hostname: requireHostname(input),
          },
          { session },
        );
      if (!hostname) throw new DomainManagementConflict('hostname_not_found');
      result = await persistEvidence(
        input,
        session,
        requestHash,
        'activate',
        hostname,
        hostname.status,
        'refused',
        'active_hostname_conflict',
        evidence,
      );
    }, transactionOptions);
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Concurrent activation refusal returned no result');
  return result;
}

export async function transitionDomain(
  input: CommonInput & {
    operation: Exclude<BookingHostnameOperationType, 'issue_challenge' | 'verify'>;
    railwayMappingReference?: string;
    railwayStatus?: string;
    tlsStatus?: string;
  },
): Promise<DomainResult> {
  const hostname = requireHostname(input);
  const validMappingReference = validRailwayMappingReference(input.railwayMappingReference)
    ? input.railwayMappingReference!
    : null;
  const extra = {
    railway_mapping_reference: validMappingReference,
    railway_status: input.railwayStatus === 'ready' ? 'ready' : null,
    tls_status: input.tlsStatus === 'ready' ? 'ready' : null,
  };
  const requestHash = requestFingerprint(input, input.operation, extra);
  const replay = await replayResult(input.database, input.requestId, requestHash);
  if (replay) return replay;
  const session = input.client.startSession();
  let result: DomainResult | undefined;
  try {
    await session.withTransaction(async () => {
      const collection = input.database.collection<TenantBookingHostnameDocument>(
        'tenant_booking_hostnames',
      );
      const current = await collection.findOne(
        { environment: environment(input), normalized_hostname: hostname },
        { session },
      );
      if (!current) throw new DomainManagementConflict('hostname_not_found');
      const decision = transitionDecision(current, input);
      if (decision.failure) {
        result = await persistEvidence(
          input,
          session,
          requestHash,
          input.operation,
          current,
          current.status,
          'refused',
          decision.failure,
          extra,
        );
        return;
      }
      if (current.status === decision.state) {
        result = await persistEvidence(
          input,
          session,
          requestHash,
          input.operation,
          current,
          current.status,
          'completed',
          null,
          extra,
        );
        return;
      }
      const now = (input.now ?? (() => new Date()))();
      const set: Partial<TenantBookingHostnameDocument> = {
        status: decision.state,
        updated_at: now,
        updated_by: input.authorization.operatorId,
      };
      if (input.operation === 'begin_provisioning')
        set.railway_mapping_reference = input.railwayMappingReference!;
      if (input.operation === 'activate')
        Object.assign(set, {
          railway_status: 'ready',
          tls_status: 'ready',
          activated_at: now,
          disabled_at: null,
        });
      if (input.operation === 'deactivate') set.disabled_at = now;
      if (input.operation === 'complete_removal')
        Object.assign(set, {
          removed_at: now,
          verification_challenge_hash: null,
          verification_expires_at: null,
          verified_at: null,
          railway_mapping_reference: null,
          railway_status: null,
          tls_status: null,
        });
      const updatedHostname = await collection.updateOne(
        { _id: current._id, status: current.status },
        { $set: set },
        { session },
      );
      if (updatedHostname.matchedCount !== 1) throw new Error('Domain transition write conflict');
      await input.beforeCommit?.('hostname');
      const updated = { ...current, ...set };
      result = await persistEvidence(
        input,
        session,
        requestHash,
        input.operation,
        updated,
        current.status,
        'completed',
        null,
        extra,
      );
    }, transactionOptions);
  } catch (error) {
    const recovered = await replayResult(input.database, input.requestId, requestHash);
    if (recovered) return recovered;
    if (input.operation === 'activate' && error instanceof MongoServerError && error.code === 11000)
      return persistConcurrentActivationRefusal(input, requestHash, extra);
    throw error;
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Domain transition transaction returned no result');
  return result;
}

function transitionDecision(
  current: TenantBookingHostnameDocument,
  input: Parameters<typeof transitionDomain>[0],
): { state: BookingHostnameStatus; failure: DomainFailure | null } {
  const allowed: Record<typeof input.operation, [BookingHostnameStatus[], BookingHostnameStatus]> =
    {
      begin_provisioning: [['verified'], 'provisioning'],
      activate: [['provisioning'], 'active'],
      deactivate: [['active', 'verified'], 'disabled'],
      begin_removal: [['disabled'], 'removing'],
      complete_removal: [['removing'], 'removed'],
    };
  const [from, state] = allowed[input.operation];
  if (current.status === state) {
    if (
      input.operation === 'begin_provisioning' &&
      (!current.verified_at ||
        !validRailwayMappingReference(input.railwayMappingReference) ||
        current.railway_mapping_reference !== input.railwayMappingReference)
    )
      return { state: current.status, failure: 'activation_evidence_incomplete' };
    if (
      input.operation === 'activate' &&
      (!current.verified_at ||
        !current.railway_mapping_reference ||
        current.railway_status !== 'ready' ||
        current.tls_status !== 'ready' ||
        input.railwayStatus !== 'ready' ||
        input.tlsStatus !== 'ready')
    )
      return { state: current.status, failure: 'activation_evidence_incomplete' };
    return { state, failure: null };
  }
  if (!from.includes(current.status))
    return { state: current.status, failure: 'invalid_transition' };
  if (
    input.operation === 'begin_provisioning' &&
    (!current.verified_at || !validRailwayMappingReference(input.railwayMappingReference))
  )
    return { state: current.status, failure: 'activation_evidence_incomplete' };
  if (
    input.operation === 'activate' &&
    (!current.verified_at ||
      !current.railway_mapping_reference ||
      input.railwayStatus !== 'ready' ||
      input.tlsStatus !== 'ready')
  )
    return { state: current.status, failure: 'activation_evidence_incomplete' };
  return { state, failure: null };
}

async function persistEvidence(
  input: CommonInput,
  session: ClientSession,
  requestFingerprint: string,
  operation: BookingHostnameOperationType,
  hostname: TenantBookingHostnameDocument,
  previous: BookingHostnameStatus | null,
  outcome: 'completed' | 'refused' | 'failed',
  failure: string | null,
  evidence: {
    txt?: string;
    railway_mapping_reference?: string | null;
    railway_status?: string | null;
    tls_status?: string | null;
  },
): Promise<DomainResult> {
  const now = (input.now ?? (() => new Date()))();
  const op: TenantBookingHostnameOperationDocument = {
    _id: new ObjectId(),
    public_id: randomUUID(),
    request_id: input.requestId,
    operation_type: operation,
    request_fingerprint: requestFingerprint,
    operator_id: input.authorization.operatorId,
    reason: input.authorization.reason,
    environment: environment(input),
    hostname_public_id: hostname.public_id,
    tenant_public_id: hostname.tenant_public_id,
    normalized_hostname: hostname.normalized_hostname,
    status: outcome,
    previous_state: previous,
    new_state: hostname.status,
    failure_category: failure,
    result: {
      txt_record_name: evidence.txt ?? null,
      operator_attested_railway_mapping_reference:
        evidence.railway_mapping_reference ?? hostname.railway_mapping_reference,
      operator_attested_railway_status: evidence.railway_status ?? hostname.railway_status,
      operator_attested_tls_status: evidence.tls_status ?? hostname.tls_status,
    },
    created_at: now,
    completed_at: now,
  };
  await input.database
    .collection<TenantBookingHostnameOperationDocument>('tenant_booking_hostname_operations')
    .insertOne(op, { session });
  await input.beforeCommit?.('operation');
  await input.database.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event: auditEvent(operation, outcome),
      outcome: outcome === 'completed' ? 'success' : 'failure',
      actor_user_id: null,
      tenant_id: hostname.tenant_id,
      request_id: input.requestId,
      metadata: {
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
        hostname_public_id: hostname.public_id,
        tenant_public_id: hostname.tenant_public_id,
        normalized_hostname: hostname.normalized_hostname,
        environment: environment(input),
        operation_type: operation,
        operation_outcome: outcome,
        previous_state: previous,
        new_state: hostname.status,
        failure_category: failure,
        railway_mapping_reference_operator_attested:
          op.result.operator_attested_railway_mapping_reference,
        railway_status_operator_attested: op.result.operator_attested_railway_status,
        tls_status_operator_attested: op.result.operator_attested_tls_status,
      },
      created_at: now,
    },
    { session },
  );
  await input.beforeCommit?.('audit');
  return operationResult(op, outcome);
}

async function replayResult(
  db: Db,
  requestId: string,
  requestFingerprint: string,
  session?: ClientSession,
): Promise<DomainResult | null> {
  const op = await db
    .collection<TenantBookingHostnameOperationDocument>('tenant_booking_hostname_operations')
    .findOne({ request_id: requestId }, session ? { session } : undefined);
  if (!op) return null;
  if (op.request_fingerprint !== requestFingerprint)
    throw new DomainManagementConflict('request_id_mismatch');
  return operationResult(op, 'replayed');
}

function operationResult(
  op: TenantBookingHostnameOperationDocument,
  outcome: DomainResult['outcome'],
): DomainResult {
  return {
    outcome,
    request_id: op.request_id,
    hostname_public_id: op.hostname_public_id,
    tenant_public_id: op.tenant_public_id,
    normalized_hostname: op.normalized_hostname,
    environment: op.environment,
    state: op.new_state,
    failure_category: op.failure_category,
    txt_record_name: op.result.txt_record_name,
    operator_attested_railway_mapping_reference:
      op.result.operator_attested_railway_mapping_reference,
    operator_attested_railway_status: op.result.operator_attested_railway_status,
    operator_attested_tls_status: op.result.operator_attested_tls_status,
  };
}

function requireHostname(input: CommonInput): string {
  const hostname = validateCustomBookingHostname(
    input.hostname,
    input.authorization.environment.BOOKING_ROOT_DOMAIN,
  );
  if (!hostname) throw new DomainManagementConflict('invalid_hostname');
  return hostname;
}
function environment(input: CommonInput): 'staging' | 'production' {
  return input.authorization.environment.ENVIRONMENT_ID as 'staging' | 'production';
}
function txtName(hostname: string): string {
  return `_booknowtech.${hostname}`;
}
function boundChallengeHash(
  input: CommonInput,
  tenantPublicId: string,
  hostname: string,
  token: string,
): string {
  return createHash('sha256')
    .update(
      `booknowtech-domain-verification:v1\n${environment(input)}\n${tenantPublicId}\n${hostname}\n${token}`,
    )
    .digest('hex');
}
function challengeMatches(
  input: CommonInput,
  hostname: TenantBookingHostnameDocument,
  value: string,
): boolean {
  const prefix = 'booknowtech-verification=';
  if (!value.startsWith(prefix)) return false;
  const token = value.slice(prefix.length);
  if (!TOKEN.test(token)) return false;
  const actual = Buffer.from(
    boundChallengeHash(input, hostname.tenant_public_id, hostname.normalized_hostname, token),
    'hex',
  );
  const expected = Buffer.from(hostname.verification_challenge_hash!, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function requestFingerprint(
  input: CommonInput,
  operation: BookingHostnameOperationType,
  extra: object,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation_type: operation,
        environment: environment(input),
        hostname: input.hostname,
        ...extra,
        operator_id: input.authorization.operatorId,
        reason: input.authorization.reason,
      }),
    )
    .digest('hex');
}

function validRailwayMappingReference(value: string | undefined): boolean {
  return Boolean(
    value &&
    value === value.trim() &&
    value.length <= 200 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }),
  );
}
function auditEvent(
  operation: BookingHostnameOperationType,
  outcome: 'completed' | 'refused' | 'failed',
): string {
  if (outcome === 'refused') return 'booking_hostname.transition_refused';
  const events: Record<BookingHostnameOperationType, string> = {
    issue_challenge: 'booking_hostname.challenge_issued',
    verify:
      outcome === 'completed'
        ? 'booking_hostname.verification_succeeded'
        : 'booking_hostname.verification_failed',
    begin_provisioning: 'booking_hostname.provisioning_started',
    activate: 'booking_hostname.activated',
    deactivate: 'booking_hostname.deactivated',
    begin_removal: 'booking_hostname.removal_started',
    complete_removal: 'booking_hostname.removed',
  };
  return events[operation];
}
