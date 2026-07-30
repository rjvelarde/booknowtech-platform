import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type ClientSession, type Collection, type Db, type Filter, ObjectId } from 'mongodb';

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
  default_slot_cadence_minutes: number;
  locale: string;
  currency: string;
  public_booking_enabled: boolean;
  public_profile: {
    business_name: string;
    description: string | null;
    tagline: string | null;
    logo_url: string | null;
    primary_color: string | null;
    website_url: string | null;
    phone_e164: string | null;
    email_normalized: string | null;
  };
  booking_policy: {
    minimum_lead_minutes: number;
    maximum_advance_days: number;
  };
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
  slot_cadence_minutes: number | null;
  currency: string;
  publicly_bookable: boolean;
  public_display_order: number;
  public_booking_policy: {
    minimum_lead_minutes: number | null;
    maximum_advance_days: number | null;
  };
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
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export interface AvailabilityInterval {
  day_of_week: number;
  start_minute: number;
  end_minute: number;
}
export interface ProviderAvailabilityScheduleDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  provider_id: ObjectId;
  timezone: string;
  weekly_hours: AvailabilityInterval[];
  breaks: AvailabilityInterval[];
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}
export interface AvailabilityExceptionDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  scope: 'tenant' | 'provider';
  provider_id: ObjectId | null;
  kind: 'holiday' | 'closure' | 'time_off';
  name: string | null;
  all_day: boolean;
  timezone: string;
  starts_on: string | null;
  ends_before: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: 'active' | 'inactive';
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export interface CustomerAddressDocument {
  public_id: string;
  label: 'home' | 'work' | 'other';
  line_1: string;
  line_2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  is_primary: boolean;
}

export interface CustomerDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  first_name: string;
  last_name: string | null;
  preferred_name: string | null;
  first_name_normalized: string;
  last_name_normalized: string | null;
  full_name_normalized: string;
  email_normalized: string | null;
  mobile_phone_e164: string | null;
  mobile_phone_digits: string | null;
  addresses: CustomerAddressDocument[];
  communication_preferences: {
    preferred_channel: 'email' | 'sms' | 'phone' | 'none' | null;
    marketing_email: 'unknown' | 'opted_in' | 'opted_out';
    marketing_sms: 'unknown' | 'opted_in' | 'opted_out';
  };
  source: 'manual' | 'seed' | 'import' | 'public_booking' | 'partner_api';
  external_references: Array<{ system: string; external_id: string; recorded_at: Date }>;
  status: 'active' | 'inactive';
  deactivated_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface AppointmentSnapshot {
  customer_display_name: string;
  provider_display_name: string;
  service_name: string;
  service_duration_minutes: number;
  slot_cadence_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  delivery_mode: DeliveryMode;
  base_price_minor: number;
  booking_fee_minor: number;
  currency: string;
}

export interface AppointmentDocument {
  _id: ObjectId;
  public_id: string;
  reference: string;
  tenant_id: ObjectId;
  customer_id: ObjectId;
  provider_id: ObjectId;
  service_id: ObjectId;
  provider_service_assignment_id: ObjectId;
  starts_at: Date;
  ends_at: Date;
  blocked_starts_at: Date;
  blocked_ends_at: Date;
  timezone: string;
  local_start_date: string;
  snapshot: AppointmentSnapshot;
  location: {
    mode: DeliveryMode;
    customer_address: Omit<CustomerAddressDocument, 'public_id' | 'label' | 'is_primary'> | null;
  };
  status: AppointmentStatus;
  source: 'business_hub' | 'seed';
  cancelled_at: Date | null;
  cancelled_by: ObjectId | null;
  cancellation_reason:
    'customer_request' | 'provider_unavailable' | 'business_closed' | 'duplicate' | 'other' | null;
  cancellation_detail: string | null;
  completed_at: Date | null;
  completed_by: ObjectId | null;
  no_show_at: Date | null;
  no_show_by: ObjectId | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by: ObjectId;
  updated_by: ObjectId;
}

export interface AppointmentCursor {
  startsAt: Date;
  publicId: string;
}

interface AppointmentScheduleLockDocument {
  tenant_id: ObjectId;
  provider_id: ObjectId;
  utc_date: string;
  revision: number;
  updated_at: Date;
}

export interface CustomerCursor {
  lastName: string | null;
  firstName: string;
  publicId: string;
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
  private readonly availabilitySchedules: Collection<ProviderAvailabilityScheduleDocument>;
  private readonly availabilityExceptions: Collection<AvailabilityExceptionDocument>;
  private readonly customers: Collection<CustomerDocument>;
  private readonly appointments: Collection<AppointmentDocument>;
  private readonly appointmentScheduleLocks: Collection<AppointmentScheduleLockDocument>;

  public constructor(private readonly database: Db) {
    const db = database;
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
    this.availabilitySchedules = db.collection('provider_availability_schedules');
    this.availabilityExceptions = db.collection('availability_exceptions');
    this.customers = db.collection<CustomerDocument>('customers');
    this.appointments = db.collection<AppointmentDocument>('appointments');
    this.appointmentScheduleLocks = db.collection<AppointmentScheduleLockDocument>(
      'appointment_schedule_locks',
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

  public getPublicTenantBySlug(slug: string): Promise<TenantDocument | null> {
    return this.tenants.findOne({ slug, status: 'active', public_booking_enabled: true });
  }

  public listPublicServices(tenantId: ObjectId): Promise<ServiceDocument[]> {
    return this.services
      .find({ tenant_id: tenantId, status: 'active', publicly_bookable: true })
      .sort({ public_display_order: 1, name: 1, public_id: 1 })
      .toArray();
  }

  public async listPublicProvidersForService(
    tenantId: ObjectId,
    serviceId: ObjectId,
  ): Promise<Array<{ provider: ProviderDocument; assignment: ProviderServiceAssignmentDocument }>> {
    const assignments = await this.providerServiceAssignments
      .find({ tenant_id: tenantId, service_id: serviceId, status: 'active' })
      .toArray();
    if (!assignments.length) return [];
    const providers = await this.providers
      .find({
        tenant_id: tenantId,
        _id: { $in: assignments.map((item) => item.provider_id) },
        status: 'active',
        customer_selectable: true,
        accepting_new_clients: true,
      })
      .sort({ display_order: 1, display_name: 1, public_id: 1 })
      .toArray();
    const byProvider = new Map(assignments.map((item) => [item.provider_id.toHexString(), item]));
    return providers.map((provider) => ({
      provider,
      assignment: byProvider.get(provider._id.toHexString())!,
    }));
  }

  public async updatePublicBookingSettings(input: {
    tenantId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    changes: Pick<TenantDocument, 'public_booking_enabled' | 'public_profile' | 'booking_policy'>;
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getBusinessProfile(input.tenantId);
    if (!current) return 'not_found';
    if (
      current.public_booking_enabled === input.changes.public_booking_enabled &&
      JSON.stringify(current.public_profile) === JSON.stringify(input.changes.public_profile) &&
      JSON.stringify(current.booking_policy) === JSON.stringify(input.changes.booking_policy)
    )
      return 'unchanged';
    const result = await this.tenants.updateOne(
      { _id: input.tenantId, status: 'active', version: input.expectedVersion },
      {
        $set: { ...input.changes, updated_by: input.userId, updated_at: new Date() },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public async updateBusinessProfile(input: {
    tenantId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        TenantDocument,
        | 'display_name'
        | 'legal_name'
        | 'contact'
        | 'default_timezone'
        | 'default_slot_cadence_minutes'
        | 'locale'
        | 'currency'
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

  public getService(
    tenantId: ObjectId,
    publicId: string,
    session?: ClientSession,
  ): Promise<ServiceDocument | null> {
    return this.services.findOne(
      { tenant_id: tenantId, public_id: publicId },
      session ? { session } : undefined,
    );
  }

  public getServiceById(
    tenantId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ): Promise<ServiceDocument | null> {
    return this.services.findOne(
      { tenant_id: tenantId, _id: id },
      session ? { session } : undefined,
    );
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
      | 'publicly_bookable'
      | 'public_display_order'
      | 'public_booking_policy'
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
      publicly_bookable: false,
      public_display_order: 0,
      public_booking_policy: {
        minimum_lead_minutes: null,
        maximum_advance_days: null,
      },
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
        | 'slot_cadence_minutes'
        | 'publicly_bookable'
        | 'public_display_order'
        | 'public_booking_policy'
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

  public getProvider(
    tenantId: ObjectId,
    publicId: string,
    session?: ClientSession,
  ): Promise<ProviderDocument | null> {
    return this.providers.findOne(
      { tenant_id: tenantId, public_id: publicId },
      session ? { session } : undefined,
    );
  }

  public getProviderById(
    tenantId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ): Promise<ProviderDocument | null> {
    return this.providers.findOne(
      { tenant_id: tenantId, _id: id },
      session ? { session } : undefined,
    );
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
    session?: ClientSession,
  ): Promise<ProviderServiceAssignmentDocument[]> {
    return this.providerServiceAssignments
      .find({ tenant_id: tenantId, provider_id: providerId }, session ? { session } : undefined)
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
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
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

  public getAvailabilitySchedule(
    tenantId: ObjectId,
    providerId: ObjectId,
    session?: ClientSession,
  ) {
    return this.availabilitySchedules.findOne(
      { tenant_id: tenantId, provider_id: providerId },
      session ? { session } : undefined,
    );
  }

  public async createAvailabilitySchedule(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    userId: ObjectId;
    timezone: string;
    weeklyHours: AvailabilityInterval[];
    breaks: AvailabilityInterval[];
  }) {
    const now = new Date();
    const document: ProviderAvailabilityScheduleDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      provider_id: input.providerId,
      timezone: input.timezone,
      weekly_hours: input.weeklyHours,
      breaks: input.breaks,
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: input.userId,
      updated_by: input.userId,
    };
    await this.availabilitySchedules.insertOne(document);
    return document;
  }

  public async updateAvailabilitySchedule(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    timezone: string;
    weeklyHours: AvailabilityInterval[];
    breaks: AvailabilityInterval[];
  }) {
    const result = await this.availabilitySchedules.updateOne(
      { tenant_id: input.tenantId, provider_id: input.providerId, version: input.expectedVersion },
      {
        $set: {
          timezone: input.timezone,
          weekly_hours: input.weeklyHours,
          breaks: input.breaks,
          updated_at: new Date(),
          updated_by: input.userId,
        },
        $inc: { version: 1 },
      },
    );
    if (result.modifiedCount === 1) return 'updated' as const;
    return (await this.getAvailabilitySchedule(input.tenantId, input.providerId))
      ? ('version_conflict' as const)
      : ('not_found' as const);
  }

  public listAvailabilityExceptions(
    tenantId: ObjectId,
    providerId?: ObjectId,
    session?: ClientSession,
  ) {
    return this.availabilityExceptions
      .find(
        {
          tenant_id: tenantId,
          ...(providerId
            ? { $or: [{ scope: 'tenant' }, { scope: 'provider', provider_id: providerId }] }
            : {}),
        },
        session ? { session } : undefined,
      )
      .sort({ starts_on: 1, starts_at: 1, public_id: 1 })
      .toArray();
  }
  public getAvailabilityException(tenantId: ObjectId, publicId: string) {
    return this.availabilityExceptions.findOne({ tenant_id: tenantId, public_id: publicId });
  }
  public async createAvailabilityException(
    input: Omit<
      AvailabilityExceptionDocument,
      '_id' | 'public_id' | 'version' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by'
    > & { userId: ObjectId },
  ) {
    const now = new Date();
    const document: AvailabilityExceptionDocument = {
      ...input,
      _id: new ObjectId(),
      public_id: randomUUID(),
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: input.userId,
      updated_by: input.userId,
    };
    delete (document as AvailabilityExceptionDocument & { userId?: ObjectId }).userId;
    await this.availabilityExceptions.insertOne(document);
    return document;
  }
  public async updateAvailabilityException(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        AvailabilityExceptionDocument,
        'name' | 'all_day' | 'timezone' | 'starts_on' | 'ends_before' | 'starts_at' | 'ends_at'
      >
    >;
  }) {
    const result = await this.availabilityExceptions.updateOne(
      { tenant_id: input.tenantId, public_id: input.publicId, version: input.expectedVersion },
      {
        $set: { ...input.changes, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    if (result.modifiedCount === 1) return 'updated' as const;
    return (await this.getAvailabilityException(input.tenantId, input.publicId))
      ? ('version_conflict' as const)
      : ('not_found' as const);
  }
  public async transitionAvailabilityException(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    status: 'active' | 'inactive';
  }) {
    const current = await this.getAvailabilityException(input.tenantId, input.publicId);
    if (!current) return 'not_found' as const;
    if (current.status === input.status) return 'unchanged' as const;
    const result = await this.availabilityExceptions.updateOne(
      { _id: current._id, tenant_id: input.tenantId, version: input.expectedVersion },
      {
        $set: { status: input.status, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? ('updated' as const) : ('version_conflict' as const);
  }
  public async updateAssignmentBuffers(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    before: number;
    after: number;
  }) {
    const current = await this.getAssignment(input.tenantId, input.providerId, input.publicId);
    if (!current) return 'not_found' as const;
    if (
      current.buffer_before_minutes === input.before &&
      current.buffer_after_minutes === input.after
    )
      return 'unchanged' as const;
    const result = await this.providerServiceAssignments.updateOne(
      { _id: current._id, tenant_id: input.tenantId, version: input.expectedVersion },
      {
        $set: {
          buffer_before_minutes: input.before,
          buffer_after_minutes: input.after,
          updated_at: new Date(),
          updated_by: input.userId,
        },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? ('updated' as const) : ('version_conflict' as const);
  }

  public listCustomers(input: {
    tenantId: ObjectId;
    status?: 'active' | 'inactive';
    textPrefix?: string;
    phonePrefix?: string;
    after?: CustomerCursor;
    limit: number;
  }): Promise<CustomerDocument[]> {
    const search = input.textPrefix
      ? {
          $or: [
            { first_name_normalized: { $regex: `^${escapeRegex(input.textPrefix)}` } },
            { last_name_normalized: { $regex: `^${escapeRegex(input.textPrefix)}` } },
            { full_name_normalized: { $regex: `^${escapeRegex(input.textPrefix)}` } },
            { email_normalized: { $regex: `^${escapeRegex(input.textPrefix)}` } },
            ...(input.phonePrefix
              ? [{ mobile_phone_digits: { $regex: `^${escapeRegex(input.phonePrefix)}` } }]
              : []),
          ],
        }
      : input.phonePrefix
        ? { mobile_phone_digits: { $regex: `^${escapeRegex(input.phonePrefix)}` } }
        : {};
    const continuation = input.after
      ? {
          $or: [
            { last_name_normalized: { $gt: input.after.lastName } },
            {
              last_name_normalized: input.after.lastName,
              first_name_normalized: { $gt: input.after.firstName },
            },
            {
              last_name_normalized: input.after.lastName,
              first_name_normalized: input.after.firstName,
              public_id: { $gt: input.after.publicId },
            },
          ],
        }
      : {};
    return this.customers
      .find({
        tenant_id: input.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...search,
        ...continuation,
      })
      .sort({ last_name_normalized: 1, first_name_normalized: 1, public_id: 1 })
      .limit(input.limit)
      .toArray();
  }

  public getCustomer(
    tenantId: ObjectId,
    publicId: string,
    session?: ClientSession,
  ): Promise<CustomerDocument | null> {
    return this.customers.findOne(
      { tenant_id: tenantId, public_id: publicId },
      session ? { session } : undefined,
    );
  }

  public getCustomerById(
    tenantId: ObjectId,
    id: ObjectId,
    session?: ClientSession,
  ): Promise<CustomerDocument | null> {
    return this.customers.findOne(
      { tenant_id: tenantId, _id: id },
      session ? { session } : undefined,
    );
  }

  public findPossibleCustomers(input: {
    tenantId: ObjectId;
    email: string | null;
    phone: string | null;
    fullName: string;
    postalCode: string | null;
    excludePublicId?: string;
  }): Promise<CustomerDocument[]> {
    const signals: Record<string, unknown>[] = [{ full_name_normalized: input.fullName }];
    if (input.email) signals.push({ email_normalized: input.email });
    if (input.phone) signals.push({ mobile_phone_e164: input.phone });
    if (input.postalCode)
      signals.push({
        full_name_normalized: input.fullName,
        addresses: { $elemMatch: { is_primary: true, postal_code: input.postalCode } },
      });
    return this.customers
      .find({
        tenant_id: input.tenantId,
        ...(input.excludePublicId ? { public_id: { $ne: input.excludePublicId } } : {}),
        $or: signals,
      })
      .sort({ last_name_normalized: 1, first_name_normalized: 1, public_id: 1 })
      .limit(5)
      .toArray();
  }

  public async createCustomer(input: {
    tenantId: ObjectId;
    userId: ObjectId;
    customer: Omit<
      CustomerDocument,
      | '_id'
      | 'public_id'
      | 'tenant_id'
      | 'status'
      | 'deactivated_at'
      | 'version'
      | 'created_at'
      | 'updated_at'
      | 'created_by'
      | 'updated_by'
    >;
  }): Promise<CustomerDocument> {
    const now = new Date();
    const customer: CustomerDocument = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      ...input.customer,
      status: 'active',
      deactivated_at: null,
      version: 1,
      created_at: now,
      updated_at: now,
      created_by: input.userId,
      updated_by: input.userId,
    };
    await this.customers.insertOne(customer);
    return customer;
  }

  public async updateCustomer(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    changes: Partial<
      Pick<
        CustomerDocument,
        | 'first_name'
        | 'last_name'
        | 'preferred_name'
        | 'first_name_normalized'
        | 'last_name_normalized'
        | 'full_name_normalized'
        | 'email_normalized'
        | 'mobile_phone_e164'
        | 'mobile_phone_digits'
        | 'addresses'
        | 'communication_preferences'
      >
    >;
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getCustomer(input.tenantId, input.publicId);
    if (!current) return 'not_found';
    const changed = Object.entries(input.changes).some(
      ([key, value]) =>
        JSON.stringify(current[key as keyof CustomerDocument]) !== JSON.stringify(value),
    );
    if (!changed) return 'unchanged';
    const result = await this.customers.updateOne(
      {
        _id: current._id,
        tenant_id: input.tenantId,
        version: input.expectedVersion,
      },
      {
        $set: { ...input.changes, updated_at: new Date(), updated_by: input.userId },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public async transitionCustomer(input: {
    tenantId: ObjectId;
    publicId: string;
    userId: ObjectId;
    expectedVersion: number;
    status: 'active' | 'inactive';
  }): Promise<'updated' | 'unchanged' | 'version_conflict' | 'not_found'> {
    const current = await this.getCustomer(input.tenantId, input.publicId);
    if (!current) return 'not_found';
    if (current.status === input.status) return 'unchanged';
    const now = new Date();
    const result = await this.customers.updateOne(
      { _id: current._id, tenant_id: input.tenantId, version: input.expectedVersion },
      {
        $set: {
          status: input.status,
          deactivated_at: input.status === 'inactive' ? now : null,
          updated_at: now,
          updated_by: input.userId,
        },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public getAppointment(
    tenantId: ObjectId,
    publicId: string,
    session?: ClientSession,
  ): Promise<AppointmentDocument | null> {
    return this.appointments.findOne(
      { tenant_id: tenantId, public_id: publicId },
      session ? { session } : undefined,
    );
  }

  public async listAppointments(input: {
    tenantId: ObjectId;
    statuses?: AppointmentStatus[];
    providerId?: ObjectId;
    serviceId?: ObjectId;
    customerIds?: ObjectId[];
    referencePrefix?: string;
    startsAtFrom?: Date;
    startsAtBefore?: Date;
    after?: AppointmentCursor;
    direction: 'ascending' | 'descending';
    limit: number;
  }): Promise<AppointmentDocument[]> {
    const order = input.direction === 'ascending' ? 1 : -1;
    const continuation: Filter<AppointmentDocument> = input.after
      ? {
          $or: [
            { starts_at: { [order === 1 ? '$gt' : '$lt']: input.after.startsAt } },
            {
              starts_at: input.after.startsAt,
              public_id: { [order === 1 ? '$gt' : '$lt']: input.after.publicId },
            },
          ],
        }
      : {};
    const startsAt = {
      ...(input.startsAtFrom ? { $gte: input.startsAtFrom } : {}),
      ...(input.startsAtBefore ? { $lt: input.startsAtBefore } : {}),
    };
    return this.appointments
      .find({
        tenant_id: input.tenantId,
        ...(input.statuses?.length ? { status: { $in: input.statuses } } : {}),
        ...(input.providerId ? { provider_id: input.providerId } : {}),
        ...(input.serviceId ? { service_id: input.serviceId } : {}),
        ...(input.customerIds ? { customer_id: { $in: input.customerIds } } : {}),
        ...(input.referencePrefix
          ? { reference: { $regex: `^${escapeRegex(input.referencePrefix.toUpperCase())}` } }
          : {}),
        ...(Object.keys(startsAt).length ? { starts_at: startsAt } : {}),
        ...continuation,
      })
      .sort({ starts_at: order, public_id: order })
      .limit(input.limit)
      .toArray();
  }

  public findAppointmentAssignment(
    tenantId: ObjectId,
    providerId: ObjectId,
    serviceId: ObjectId,
    session?: ClientSession,
  ): Promise<ProviderServiceAssignmentDocument | null> {
    return this.providerServiceAssignments.findOne(
      { tenant_id: tenantId, provider_id: providerId, service_id: serviceId },
      session ? { session } : undefined,
    );
  }

  public listBlockingAppointments(input: {
    tenantId: ObjectId;
    providerId: ObjectId;
    startsBefore: Date;
    endsAfter: Date;
    excludeAppointmentId?: ObjectId;
    session?: ClientSession;
  }): Promise<AppointmentDocument[]> {
    return this.appointments
      .find(
        {
          tenant_id: input.tenantId,
          provider_id: input.providerId,
          status: 'scheduled',
          blocked_starts_at: { $lt: input.startsBefore },
          blocked_ends_at: { $gt: input.endsAfter },
          ...(input.excludeAppointmentId ? { _id: { $ne: input.excludeAppointmentId } } : {}),
        },
        input.session ? { session: input.session } : undefined,
      )
      .sort({ blocked_starts_at: 1, public_id: 1 })
      .toArray();
  }

  public async getScheduleLockRevisions(
    tenantId: ObjectId,
    providerId: ObjectId,
    utcDates: string[],
  ): Promise<string[]> {
    const documents = await this.appointmentScheduleLocks
      .find({ tenant_id: tenantId, provider_id: providerId, utc_date: { $in: utcDates } })
      .sort({ utc_date: 1 })
      .toArray();
    const revisions = new Map(documents.map((item) => [item.utc_date, item.revision]));
    return utcDates
      .slice()
      .sort()
      .map((date) => `${date}:${revisions.get(date) ?? 0}`);
  }

  public async withAppointmentScheduleLocks<T>(
    tenantId: ObjectId,
    scopes: Array<{ providerId: ObjectId; utcDate: string }>,
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const unique = new Map<string, { providerId: ObjectId; utcDate: string }>();
    for (const scope of scopes)
      unique.set(`${scope.providerId.toHexString()}:${scope.utcDate}`, scope);
    const ordered = [...unique.values()].sort((left, right) =>
      `${left.providerId.toHexString()}:${left.utcDate}`.localeCompare(
        `${right.providerId.toHexString()}:${right.utcDate}`,
      ),
    );
    const now = new Date();
    for (const scope of ordered)
      await this.appointmentScheduleLocks.updateOne(
        { tenant_id: tenantId, provider_id: scope.providerId, utc_date: scope.utcDate },
        { $setOnInsert: { revision: 0, updated_at: now } },
        { upsert: true },
      );

    const session = this.database.client.startSession();
    try {
      const result = await session.withTransaction(
        async () => {
          for (const scope of ordered)
            await this.appointmentScheduleLocks.updateOne(
              { tenant_id: tenantId, provider_id: scope.providerId, utc_date: scope.utcDate },
              { $inc: { revision: 1 }, $set: { updated_at: new Date() } },
              { session },
            );
          return work(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
      if (result === undefined) throw new Error('Appointment transaction returned no result');
      return result;
    } finally {
      await session.endSession();
    }
  }

  public async insertAppointment(
    input: Omit<AppointmentDocument, '_id' | 'public_id' | 'reference'>,
    session: ClientSession,
  ): Promise<AppointmentDocument> {
    const publicId = randomUUID();
    const appointment: AppointmentDocument = {
      ...input,
      _id: new ObjectId(),
      public_id: publicId,
      reference: `BNT-${publicId.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
    };
    await this.appointments.insertOne(appointment, { session });
    return appointment;
  }

  public async updateAppointmentSchedule(input: {
    appointment: AppointmentDocument;
    tenantId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    startsAt: Date;
    endsAt: Date;
    blockedStartsAt: Date;
    blockedEndsAt: Date;
    localStartDate: string;
    session: ClientSession;
  }): Promise<'updated' | 'version_conflict'> {
    const result = await this.appointments.updateOne(
      {
        _id: input.appointment._id,
        tenant_id: input.tenantId,
        status: 'scheduled',
        version: input.expectedVersion,
      },
      {
        $set: {
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          blocked_starts_at: input.blockedStartsAt,
          blocked_ends_at: input.blockedEndsAt,
          local_start_date: input.localStartDate,
          updated_at: new Date(),
          updated_by: input.userId,
        },
        $inc: { version: 1 },
      },
      { session: input.session },
    );
    return result.modifiedCount === 1 ? 'updated' : 'version_conflict';
  }

  public async transitionAppointment(input: {
    appointment: AppointmentDocument;
    tenantId: ObjectId;
    userId: ObjectId;
    expectedVersion: number;
    status: Exclude<AppointmentStatus, 'scheduled'>;
    reason?: AppointmentDocument['cancellation_reason'];
    detail?: string | null;
    session: ClientSession;
  }): Promise<'updated' | 'version_conflict'> {
    const now = new Date();
    const lifecycle =
      input.status === 'cancelled'
        ? {
            cancelled_at: now,
            cancelled_by: input.userId,
            cancellation_reason: input.reason ?? null,
            cancellation_detail: input.detail ?? null,
          }
        : input.status === 'completed'
          ? { completed_at: now, completed_by: input.userId }
          : { no_show_at: now, no_show_by: input.userId };
    const result = await this.appointments.updateOne(
      {
        _id: input.appointment._id,
        tenant_id: input.tenantId,
        status: 'scheduled',
        version: input.expectedVersion,
      },
      {
        $set: {
          status: input.status,
          ...lifecycle,
          updated_at: now,
          updated_by: input.userId,
        },
        $inc: { version: 1 },
      },
      { session: input.session },
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
