import type { Db, Document } from 'mongodb';

const validators: Record<string, Document> = {
  tenants: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'slug',
        'display_name',
        'legal_name',
        'contact',
        'default_timezone',
        'locale',
        'currency',
        'version',
        'updated_by',
        'status',
        'created_at',
        'updated_at',
      ],
      properties: {
        contact: {
          bsonType: 'object',
          required: ['email_normalized', 'phone_e164', 'website_url'],
        },
        currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        status: { enum: ['active', 'suspended'] },
      },
    },
  },
  users: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'email_normalized',
        'display_name',
        'password_hash',
        'status',
        'created_at',
        'updated_at',
      ],
      properties: { status: { enum: ['active', 'disabled'] } },
    },
  },
  roles: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['public_id', 'tenant_id', 'user_id', 'role', 'status', 'created_at', 'updated_at'],
      properties: {
        role: { enum: ['tenant_owner', 'tenant_admin', 'provider', 'front_desk'] },
        status: { enum: ['active', 'suspended', 'revoked'] },
      },
    },
  },
  admin_sessions: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'token_hash',
        'audience',
        'user_id',
        'csrf_token_hash',
        'created_at',
        'rotated_at',
        'last_seen_at',
        'expires_at',
        'created_request_id',
      ],
      properties: { audience: { enum: ['admin'] } },
    },
  },
  audit_logs: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['public_id', 'event', 'outcome', 'request_id', 'metadata', 'created_at'],
      properties: { outcome: { enum: ['success', 'failure'] } },
    },
  },
  services: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'internal_code',
        'name',
        'description',
        'delivery_mode',
        'duration_minutes',
        'base_price_minor',
        'booking_fee_minor',
        'currency',
        'status',
        'version',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at',
      ],
      properties: {
        tenant_id: { bsonType: 'objectId' },
        internal_code: {
          bsonType: ['string', 'null'],
          maxLength: 64,
          pattern: '^[A-Z0-9._-]+$',
        },
        delivery_mode: {
          enum: ['provider_location', 'customer_location', 'virtual'],
        },
        duration_minutes: { bsonType: ['int', 'long'], minimum: 5, maximum: 1440 },
        base_price_minor: { bsonType: ['int', 'long'], minimum: 0 },
        booking_fee_minor: { bsonType: ['int', 'long'], minimum: 0 },
        currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
        status: { enum: ['active', 'inactive'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
      },
    },
  },
  providers: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'internal_code',
        'display_name',
        'first_name',
        'last_name',
        'email_normalized',
        'phone_e164',
        'photo_url',
        'bio',
        'status',
        'customer_selectable',
        'accepting_new_clients',
        'display_order',
        'linked_user_id',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        public_id: { bsonType: 'string' },
        tenant_id: { bsonType: 'objectId' },
        internal_code: { bsonType: ['string', 'null'], maxLength: 64, pattern: '^[A-Z0-9._-]+$' },
        display_name: { bsonType: 'string', minLength: 1, maxLength: 160 },
        first_name: { bsonType: ['string', 'null'], maxLength: 100 },
        last_name: { bsonType: ['string', 'null'], maxLength: 100 },
        email_normalized: { bsonType: ['string', 'null'], maxLength: 320 },
        phone_e164: { bsonType: ['string', 'null'], pattern: '^\\+[1-9][0-9]{1,14}$' },
        photo_url: { bsonType: ['string', 'null'], maxLength: 2048, pattern: '^https://' },
        bio: { bsonType: ['string', 'null'], maxLength: 4000 },
        status: { enum: ['active', 'inactive'] },
        customer_selectable: { bsonType: 'bool' },
        accepting_new_clients: { bsonType: 'bool' },
        display_order: { bsonType: ['int', 'long'], minimum: 0, maximum: 1000000 },
        linked_user_id: { bsonType: ['objectId', 'null'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        created_by: { bsonType: 'objectId' },
        updated_by: { bsonType: 'objectId' },
      },
    },
  },
  provider_service_assignments: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'provider_id',
        'service_id',
        'status',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        public_id: { bsonType: 'string' },
        tenant_id: { bsonType: 'objectId' },
        provider_id: { bsonType: 'objectId' },
        service_id: { bsonType: 'objectId' },
        status: { enum: ['active', 'inactive'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        created_by: { bsonType: 'objectId' },
        updated_by: { bsonType: 'objectId' },
      },
    },
  },
};

export async function migrateDatabase(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name),
  );
  if (existing.has('tenants')) {
    await db.collection('tenants').updateMany({}, [
      {
        $set: {
          legal_name: { $ifNull: ['$legal_name', null] },
          contact: {
            $ifNull: ['$contact', { email_normalized: null, phone_e164: null, website_url: null }],
          },
          default_timezone: { $ifNull: ['$default_timezone', 'UTC'] },
          locale: { $ifNull: ['$locale', 'en-US'] },
          currency: { $ifNull: ['$currency', 'USD'] },
          version: { $ifNull: ['$version', 1] },
          updated_by: { $ifNull: ['$updated_by', null] },
        },
      },
    ]);
  }
  for (const [name, validator] of Object.entries(validators)) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationLevel: 'strict' });
    } else {
      await db.createCollection(name, { validator, validationLevel: 'strict' });
    }
  }

  await db.collection('tenants').createIndexes([
    { key: { public_id: 1 }, name: 'tenants_public_id_unique', unique: true },
    { key: { slug: 1 }, name: 'tenants_slug_unique', unique: true },
    { key: { status: 1 }, name: 'tenants_status' },
  ]);
  await db.collection('users').createIndexes([
    { key: { public_id: 1 }, name: 'users_public_id_unique', unique: true },
    {
      key: { email_normalized: 1 },
      name: 'users_email_normalized_unique',
      unique: true,
      sparse: true,
    },
    { key: { status: 1 }, name: 'users_status' },
  ]);
  await db.collection('roles').createIndexes([
    {
      key: { tenant_id: 1, user_id: 1, role: 1 },
      name: 'roles_tenant_user_role_unique',
      unique: true,
    },
    { key: { user_id: 1, status: 1 }, name: 'roles_user_status' },
    { key: { tenant_id: 1, role: 1, status: 1 }, name: 'roles_tenant_role_status' },
    { key: { public_id: 1 }, name: 'roles_public_id_unique', unique: true },
  ]);
  await db.collection('admin_sessions').createIndexes([
    { key: { public_id: 1 }, name: 'admin_sessions_public_id_unique', unique: true },
    { key: { token_hash: 1 }, name: 'admin_sessions_token_hash_unique', unique: true },
    { key: { expires_at: 1 }, name: 'admin_sessions_expiry_ttl', expireAfterSeconds: 0 },
    {
      key: { user_id: 1, revoked_at: 1, expires_at: 1 },
      name: 'admin_sessions_user_revocation',
    },
    {
      key: { selected_membership_id: 1, revoked_at: 1 },
      name: 'admin_sessions_membership_revocation',
    },
  ]);
  await db.collection('audit_logs').createIndexes([
    { key: { public_id: 1 }, name: 'audit_logs_public_id_unique', unique: true },
    { key: { actor_user_id: 1, created_at: -1 }, name: 'audit_logs_actor_created' },
    { key: { tenant_id: 1, created_at: -1 }, name: 'audit_logs_tenant_created' },
    { key: { event: 1, created_at: -1 }, name: 'audit_logs_event_created' },
    { key: { request_id: 1 }, name: 'audit_logs_request_id' },
  ]);
  await db.collection('services').createIndexes([
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'services_tenant_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, internal_code: 1 },
      name: 'services_tenant_internal_code_unique',
      unique: true,
      partialFilterExpression: { internal_code: { $type: 'string' } },
    },
    { key: { tenant_id: 1, status: 1, name: 1, public_id: 1 }, name: 'services_catalog_list' },
    { key: { tenant_id: 1, updated_at: -1, public_id: 1 }, name: 'services_updated' },
  ]);
  await db.collection('providers').createIndexes([
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'providers_tenant_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, internal_code: 1 },
      name: 'providers_tenant_internal_code_unique',
      unique: true,
      partialFilterExpression: { internal_code: { $type: 'string' } },
    },
    {
      key: { tenant_id: 1, status: 1, display_order: 1, display_name: 1, public_id: 1 },
      name: 'providers_directory_list',
    },
    { key: { tenant_id: 1, updated_at: -1, public_id: 1 }, name: 'providers_updated' },
  ]);
  await db.collection('provider_service_assignments').createIndexes([
    {
      key: { tenant_id: 1, provider_id: 1, service_id: 1 },
      name: 'provider_service_tenant_provider_service_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'provider_service_tenant_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, provider_id: 1, status: 1, service_id: 1 },
      name: 'provider_service_by_provider',
    },
    {
      key: { tenant_id: 1, service_id: 1, status: 1, provider_id: 1 },
      name: 'provider_service_by_service',
    },
    {
      key: { tenant_id: 1, updated_at: -1, public_id: 1 },
      name: 'provider_service_updated',
    },
  ]);
}
