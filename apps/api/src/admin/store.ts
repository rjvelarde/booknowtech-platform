import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Collection, type Db, ObjectId } from 'mongodb';

export const ADMIN_ROLES = ['tenant_owner', 'tenant_admin', 'provider', 'front_desk'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface TenantDocument {
  _id: ObjectId;
  public_id: string;
  slug: string;
  display_name: string;
  legal_name: string | null;
  contact: {
    email_normalized: string | null;
    phone_e164: string | null;
    website_url: string | null;
  };
  default_timezone: string;
  locale: string;
  currency: string;
  version: number;
  updated_by: ObjectId | null;
  status: 'active' | 'suspended';
  created_at: Date;
  updated_at: Date;
}

export const DELIVERY_MODES = ['provider_location', 'customer_location', 'virtual'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface ServiceDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  internal_code: string | null;
  name: string;
  description: string | null;
  delivery_mode: DeliveryMode;
  duration_minutes: number;
  base_price_minor: number;
  booking_fee_minor: number;
  currency: string;
  status: 'active' | 'inactive';
  version: number;
  created_by: ObjectId;
  updated_by: ObjectId;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  internal_code: string | null;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  photo_url: string | null;
  bio: string | null;
  status: 'active' | 'inactive';
  customer_selectable: boolean;
  accepting_new_clients: boolean;
  display_order: number;
  linked_user_id: ObjectId | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export interface ProviderServiceAssignmentDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  provider_id: ObjectId;
  service_id: ObjectId;
  status: 'active' | 'inactive';
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export interface ProviderCursor {
  displayOrder: number;
  displayName: string;
  publicId: string;
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
  private readonly services: Collection<ServiceDocument>;
  private readonly providers: Collection<ProviderDocument>;
  private readonly providerServiceAssignments: Collection<ProviderServiceAssignmentDocument>;

  public constructor(db: Db) {
    this.tenants = db.collection<TenantDocument>('tenants');
    this.users = db.collection<UserDocument>('users');
    this.roles = db.collection<RoleDocument>('roles');
    this.sessions = db.collection<AdminSessionDocument>('admin_sessions');
    this.auditLogs = db.collection<AuditLogDocument>('audit_logs');
    this.services = db.collection<ServiceDocument>('services');
    this.providers = db.collection<ProviderDocument>('providers');
    this.providerServiceAssignments = db.collection<ProviderServiceAssignmentDocument>(
      'provider_service_assignments',
    );
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

  public getBusinessProfile(tenantId: ObjectId): Promise<TenantDocument | null> {
    return this.tenants.findOne({ _id: tenantId, status: 'active' });
  }

  public async updateBusinessProfile(input: {
    tenantId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        TenantDocument,
        'display_name' | 'legal_name' | 'contact' | 'default_timezone' | 'locale' | 'currency'
      >
    >;
  }): Promise<'updated' | 'version_conflict' | 'currency_locked' | 'not_found'> {
    const tenant = await this.tenants.findOne({ _id: input.tenantId, status: 'active' });
    if (!tenant) return 'not_found';
    if (input.changes.currency && input.changes.currency !== tenant.currency) {
      if ((await this.services.countDocuments({ tenant_id: input.tenantId }, { limit: 1 })) > 0) {
        return 'currency_locked';
      }
    }
    const result = await this.tenants.updateOne(
      { _id: input.tenantId, status: 'active', version: input.expectedVersion },
      {
        $set: { ...input.changes, updated_by: input.userId, updated_at: new Date() },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public listServices(tenantId: ObjectId): Promise<ServiceDocument[]> {
    return this.services.find({ tenant_id: tenantId }).sort({ name: 1, public_id: 1 }).toArray();
  }

  public getService(tenantId: ObjectId, publicId: string): Promise<ServiceDocument | null> {
    return this.services.findOne({ tenant_id: tenantId, public_id: publicId });
  }

  public getServiceById(tenantId: ObjectId, id: ObjectId): Promise<ServiceDocument | null> {
    return this.services.findOne({ tenant_id: tenantId, _id: id });
  }

  public async createService(
    tenant: TenantDocument,
    userId: ObjectId,
    input: Omit<
      ServiceDocument,
      | '_id'
      | 'public_id'
      | 'tenant_id'
      | 'currency'
      | 'version'
      | 'created_by'
      | 'updated_by'
      | 'created_at'
      | 'updated_at'
    >,
  ): Promise<ServiceDocument> {
    const now = new Date();
    const document: ServiceDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: tenant._id,
      currency: tenant.currency,
      version: 1,
      created_by: userId,
      updated_by: userId,
      created_at: now,
      updated_at: now,
      ...input,
    };
    await this.services.insertOne(document);
    return document;
  }

  public async updateService(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        ServiceDocument,
        | 'internal_code'
        | 'name'
        | 'description'
        | 'delivery_mode'
        | 'duration_minutes'
        | 'base_price_minor'
        | 'booking_fee_minor'
      >
    >;
  }): Promise<'updated' | 'version_conflict' | 'not_found'> {
    const result = await this.services.updateOne(
      {
        tenant_id: input.tenantId,
        public_id: input.publicId,
        version: input.expectedVersion,
      },
      {
        $set: { ...input.changes, updated_by: input.userId, updated_at: new Date() },
        $inc: { version: 1 },
      },
    );
    if (result.modifiedCount === 1) return 'updated';
    return (await this.getService(input.tenantId, input.publicId))
      ? 'version_conflict'
      : 'not_found';
  }

  public async transitionService(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    status: 'active' | 'inactive';
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getService(input.tenantId, input.publicId);
    if (!current) return 'not_found';
    if (current.status === input.status) return 'unchanged';
    const result = await this.services.updateOne(
      {
        _id: current._id,
        tenant_id: input.tenantId,
        version: input.expectedVersion,
        status: current.status,
      },
      {
        $set: { status: input.status, updated_by: input.userId, updated_at: new Date() },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public listProviders(input: {
    tenantId: ObjectId;
    status?: 'active' | 'inactive';
    after?: ProviderCursor;
    limit: number;
  }): Promise<ProviderDocument[]> {
    const continuation = input.after
      ? {
          $or: [
            { display_order: { $gt: input.after.displayOrder } },
            {
              display_order: input.after.displayOrder,
              display_name: { $gt: input.after.displayName },
            },
            {
              display_order: input.after.displayOrder,
              display_name: input.after.displayName,
              public_id: { $gt: input.after.publicId },
            },
          ],
        }
      : {};
    return this.providers
      .find({
        tenant_id: input.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...continuation,
      })
      .sort({ display_order: 1, display_name: 1, public_id: 1 })
      .limit(input.limit)
      .toArray();
  }

  public getProvider(tenantId: ObjectId, publicId: string): Promise<ProviderDocument | null> {
    return this.providers.findOne({ tenant_id: tenantId, public_id: publicId });
  }

  public getProviderById(tenantId: ObjectId, id: ObjectId): Promise<ProviderDocument | null> {
    return this.providers.findOne({ tenant_id: tenantId, _id: id });
  }

  public async createProvider(
    tenantId: ObjectId,
    userId: ObjectId,
    input: Omit<
      ProviderDocument,
      | '_id'
      | 'public_id'
      | 'tenant_id'
      | 'status'
      | 'linked_user_id'
      | 'version'
      | 'created_at'
      | 'updated_at'
      | 'created_by'
      | 'updated_by'
    >,
  ): Promise<ProviderDocument> {
    const now = new Date();
    const provider: ProviderDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: tenantId,
      status: 'active',
      linked_user_id: null,
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: userId,
      updated_by: userId,
      ...input,
    };
    await this.providers.insertOne(provider);
    return provider;
  }

  public async updateProvider(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        ProviderDocument,
        | 'internal_code'
        | 'display_name'
        | 'first_name'
        | 'last_name'
        | 'email_normalized'
        | 'phone_e164'
        | 'photo_url'
        | 'bio'
        | 'customer_selectable'
        | 'accepting_new_clients'
        | 'display_order'
      >
    >;
  }): Promise<'updated' | 'version_conflict' | 'not_found'> {
    const result = await this.providers.updateOne(
      { tenant_id: input.tenantId, public_id: input.publicId, version: input.expectedVersion },
      {
        $set: { ...input.changes, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    if (result.modifiedCount === 1) return 'updated';
    return (await this.getProvider(input.tenantId, input.publicId))
      ? 'version_conflict'
      : 'not_found';
  }

  public async transitionProvider(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    status: 'active' | 'inactive';
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getProvider(input.tenantId, input.publicId);
    if (!current) return 'not_found';
    if (current.status === input.status) return 'unchanged';
    const result = await this.providers.updateOne(
      {
        _id: current._id,
        tenant_id: input.tenantId,
        version: input.expectedVersion,
        status: current.status,
      },
      {
        $set: { status: input.status, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public listAssignmentsForProvider(
    tenantId: ObjectId,
    providerId: ObjectId,
  ): Promise<ProviderServiceAssignmentDocument[]> {
    return this.providerServiceAssignments
      .find({ tenant_id: tenantId, provider_id: providerId })
      .sort({ created_at: 1, public_id: 1 })
      .toArray();
  }

  public listAssignmentsForService(
    tenantId: ObjectId,
    serviceId: ObjectId,
  ): Promise<ProviderServiceAssignmentDocument[]> {
    return this.providerServiceAssignments
      .find({ tenant_id: tenantId, service_id: serviceId })
      .sort({ created_at: 1, public_id: 1 })
      .toArray();
  }

  public getAssignment(
    tenantId: ObjectId,
    providerId: ObjectId,
    publicId: string,
  ): Promise<ProviderServiceAssignmentDocument | null> {
    return this.providerServiceAssignments.findOne({
      tenant_id: tenantId,
      provider_id: providerId,
      public_id: publicId,
    });
  }

  public async createAssignment(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    serviceId: ObjectId;
    userId: ObjectId;
  }): Promise<{
    result: 'created' | 'unchanged' | 'inactive';
    assignment: ProviderServiceAssignmentDocument;
  }> {
    const existing = await this.providerServiceAssignments.findOne({
      tenant_id: input.tenantId,
      provider_id: input.providerId,
      service_id: input.serviceId,
    });
    if (existing)
      return {
        result: existing.status === 'active' ? 'unchanged' : 'inactive',
        assignment: existing,
      };
    const now = new Date();
    const assignment: ProviderServiceAssignmentDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      provider_id: input.providerId,
      service_id: input.serviceId,
      status: 'active',
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: input.userId,
      updated_by: input.userId,
    };
    try {
      await this.providerServiceAssignments.insertOne(assignment);
      return { result: 'created', assignment };
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000))
        throw error;
      const concurrent = await this.providerServiceAssignments.findOne({
        tenant_id: input.tenantId,
        provider_id: input.providerId,
        service_id: input.serviceId,
      });
      if (!concurrent) throw error;
      return {
        result: concurrent.status === 'active' ? 'unchanged' : 'inactive',
        assignment: concurrent,
      };
    }
  }

  public async transitionAssignment(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    status: 'active' | 'inactive';
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getAssignment(input.tenantId, input.providerId, input.publicId);
    if (!current) return 'not_found';
    if (current.status === input.status) return 'unchanged';
    const result = await this.providerServiceAssignments.updateOne(
      {
        _id: current._id,
        tenant_id: input.tenantId,
        provider_id: input.providerId,
        version: input.expectedVersion,
        status: current.status,
      },
      {
        $set: { status: input.status, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
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
