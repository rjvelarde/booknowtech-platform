import type { Db, Document } from 'mongodb';

const validators: Record<string, Document> = {
  tenants: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['public_id', 'slug', 'display_name', 'status', 'created_at', 'updated_at'],
      properties: { status: { enum: ['active', 'suspended'] } },
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
};

export async function migrateDatabase(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name),
  );
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
}
