import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Collection, type Db, ObjectId } from 'mongodb';

export const ADMIN_ROLES = ['tenant_owner', 'tenant_admin', 'provider', 'front_desk'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface TenantDocument {
  _id: ObjectId;
  public_id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'suspended';
  created_at: Date;
  updated_at: Date;
}

export interface UserDocument {
  _id: ObjectId;
  public_id: string;
  email_normalized: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: Date;
  updated_at: Date;
}

export interface RoleDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  user_id: ObjectId;
  role: AdminRole;
  status: 'active' | 'suspended' | 'revoked';
  created_at: Date;
  updated_at: Date;
}

interface AdminSessionDocument {
  _id: ObjectId;
  public_id: string;
  token_hash: string;
  audience: 'admin';
  user_id: ObjectId;
  selected_membership_id: ObjectId | null;
  csrf_token_hash: string;
  created_at: Date;
  rotated_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  created_request_id: string;
}

interface AuditLogDocument {
  public_id: string;
  event: string;
  outcome: 'success' | 'failure';
  actor_user_id: ObjectId | null;
  tenant_id: ObjectId | null;
  request_id: string;
  metadata: Record<string, string | null>;
  created_at: Date;
}

export interface SessionCredential {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface VerifiedAdminContext {
  session: AdminSessionDocument;
  user: UserDocument;
  membership: RoleDocument | null;
  tenant: TenantDocument | null;
  memberships: Array<{ membership: RoleDocument; tenant: TenantDocument }>;
}

const SESSION_DURATION_MILLISECONDS = 8 * 60 * 60 * 1_000;

export class AdminStore {
  private readonly tenants: Collection<TenantDocument>;
  private readonly users: Collection<UserDocument>;
  private readonly roles: Collection<RoleDocument>;
  private readonly sessions: Collection<AdminSessionDocument>;
  private readonly auditLogs: Collection<AuditLogDocument>;

  public constructor(db: Db) {
    this.tenants = db.collection<TenantDocument>('tenants');
    this.users = db.collection<UserDocument>('users');
    this.roles = db.collection<RoleDocument>('roles');
    this.sessions = db.collection<AdminSessionDocument>('admin_sessions');
    this.auditLogs = db.collection<AuditLogDocument>('audit_logs');
  }

  public findUserByEmail(email: string): Promise<UserDocument | null> {
    return this.users.findOne({ email_normalized: normalizeEmail(email), status: 'active' });
  }

  public async createSession(userId: ObjectId, requestId: string): Promise<SessionCredential> {
    const memberships = await this.loadMemberships(userId);
    const selectedMembershipId = memberships.length === 1 ? memberships[0]!.membership._id : null;
    return this.insertSession(userId, selectedMembershipId, requestId);
  }

  public async hydrateSession(token: string): Promise<VerifiedAdminContext | null> {
    const now = new Date();
    const session = await this.sessions.findOne({
      token_hash: hashSecret(token),
      audience: 'admin',
      revoked_at: null,
      expires_at: { $gt: now },
    });
    if (!session) return null;

    const user = await this.users.findOne({ _id: session.user_id, status: 'active' });
    if (!user) return null;
    const memberships = await this.loadMemberships(user._id);
    const selectedMembershipId = session.selected_membership_id;
    const selected = selectedMembershipId
      ? memberships.find(({ membership }) => membership._id.equals(selectedMembershipId))
      : undefined;
    if (session.selected_membership_id && !selected) return null;

    await this.sessions.updateOne({ _id: session._id }, { $set: { last_seen_at: now } });
    return {
      session,
      user,
      membership: selected?.membership ?? null,
      tenant: selected?.tenant ?? null,
      memberships,
    };
  }

  public async rotateCsrf(session: AdminSessionDocument): Promise<string> {
    const csrfToken = createToken();
    await this.sessions.updateOne(
      { _id: session._id, revoked_at: null },
      { $set: { csrf_token_hash: hashSecret(csrfToken), rotated_at: new Date() } },
    );
    return csrfToken;
  }

  public verifyCsrf(session: AdminSessionDocument, csrfToken: string | undefined): boolean {
    if (!csrfToken) return false;
    const actual = Buffer.from(hashSecret(csrfToken), 'hex');
    const expected = Buffer.from(session.csrf_token_hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  public async switchMembership(
    context: VerifiedAdminContext,
    membershipPublicId: string,
    requestId: string,
  ): Promise<SessionCredential | null> {
    const selected = context.memberships.find(
      ({ membership }) => membership.public_id === membershipPublicId,
    );
    if (!selected) return null;

    await this.revokeSession(context.session, 'tenant_switch');
    return this.insertSession(context.user._id, selected.membership._id, requestId);
  }

  public revokeSession(session: AdminSessionDocument, reason: string): Promise<unknown> {
    return this.sessions.updateOne(
      { _id: session._id, revoked_at: null },
      { $set: { revoked_at: new Date(), revocation_reason: reason } },
    );
  }

  public async audit(input: {
    event: string;
    outcome: 'success' | 'failure';
    actorUserId?: ObjectId | null;
    tenantId?: ObjectId | null;
    requestId: string;
    metadata?: Record<string, string | null>;
  }): Promise<void> {
    await this.auditLogs.insertOne({
      public_id: randomUUID(),
      event: input.event,
      outcome: input.outcome,
      actor_user_id: input.actorUserId ?? null,
      tenant_id: input.tenantId ?? null,
      request_id: input.requestId,
      metadata: input.metadata ?? {},
      created_at: new Date(),
    });
  }

  private async loadMemberships(
    userId: ObjectId,
  ): Promise<Array<{ membership: RoleDocument; tenant: TenantDocument }>> {
    const roles = await this.roles.find({ user_id: userId, status: 'active' }).toArray();
    const memberships: Array<{ membership: RoleDocument; tenant: TenantDocument }> = [];
    for (const membership of roles) {
      const tenant = await this.tenants.findOne({ _id: membership.tenant_id, status: 'active' });
      if (tenant) memberships.push({ membership, tenant });
    }
    return memberships;
  }

  private async insertSession(
    userId: ObjectId,
    selectedMembershipId: ObjectId | null,
    requestId: string,
  ): Promise<SessionCredential> {
    const now = new Date();
    const token = createToken();
    const csrfToken = createToken();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MILLISECONDS);
    await this.sessions.insertOne({
      _id: new ObjectId(),
      public_id: randomUUID(),
      token_hash: hashSecret(token),
      audience: 'admin',
      user_id: userId,
      selected_membership_id: selectedMembershipId,
      csrf_token_hash: hashSecret(csrfToken),
      created_at: now,
      rotated_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
      created_request_id: requestId,
    });
    return { token, csrfToken, expiresAt };
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
