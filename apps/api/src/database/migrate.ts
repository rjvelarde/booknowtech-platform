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
        'default_slot_cadence_minutes',
        'locale',
        'currency',
        'public_booking_enabled',
        'public_profile',
        'booking_policy',
        'public_booking_terms',
        'appointment_email_settings',
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
        public_booking_enabled: { bsonType: 'bool' },
        public_profile: {
          bsonType: 'object',
          required: [
            'business_name',
            'description',
            'tagline',
            'logo_url',
            'primary_color',
            'website_url',
            'phone_e164',
            'email_normalized',
          ],
          properties: {
            business_name: { bsonType: 'string', minLength: 1, maxLength: 120 },
            description: { bsonType: ['string', 'null'], maxLength: 1000 },
            tagline: { bsonType: ['string', 'null'], maxLength: 160 },
            logo_url: { bsonType: ['string', 'null'], maxLength: 2048, pattern: '^https://' },
            primary_color: { bsonType: ['string', 'null'], pattern: '^#[A-F0-9]{6}$' },
            website_url: { bsonType: ['string', 'null'], maxLength: 2048, pattern: '^https://' },
            phone_e164: { bsonType: ['string', 'null'], pattern: '^\\+[1-9][0-9]{1,14}$' },
            email_normalized: { bsonType: ['string', 'null'], maxLength: 320 },
          },
        },
        booking_policy: {
          bsonType: 'object',
          required: ['minimum_lead_minutes', 'maximum_advance_days'],
          properties: {
            minimum_lead_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 43200 },
            maximum_advance_days: { bsonType: ['int', 'long'], minimum: 1, maximum: 365 },
          },
        },
        public_booking_terms: {
          bsonType: 'object',
          required: ['version', 'acknowledgment_label', 'terms_url'],
          properties: {
            version: { bsonType: 'string', minLength: 1, maxLength: 64 },
            acknowledgment_label: { bsonType: 'string', minLength: 1, maxLength: 300 },
            terms_url: { bsonType: ['string', 'null'], maxLength: 2048, pattern: '^https://' },
          },
        },
        appointment_email_settings: {
          bsonType: 'object',
          required: ['enabled', 'sender_name', 'reply_to_email'],
          properties: {
            enabled: { bsonType: 'bool' },
            sender_name: { bsonType: 'string', minLength: 1, maxLength: 120 },
            reply_to_email: { bsonType: ['string', 'null'], maxLength: 320 },
          },
        },
        default_slot_cadence_minutes: { enum: [5, 10, 15, 20, 30, 60] },
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
  notification_outbox: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'appointment_id',
        'appointment_public_id',
        'appointment_reference',
        'type',
        'channel',
        'recipient',
        'template_data',
        'status',
        'attempt_count',
        'next_attempt_at',
        'processing_started_at',
        'delivered_at',
        'failed_at',
        'provider_message_id',
        'last_error_code',
        'request_id',
        'created_at',
        'updated_at',
      ],
      properties: {
        type: {
          enum: ['appointment_confirmation', 'appointment_rescheduled', 'appointment_cancelled'],
        },
        channel: { enum: ['email'] },
        status: { enum: ['pending', 'processing', 'delivered', 'failed'] },
        recipient: { bsonType: 'string', minLength: 3, maxLength: 320 },
        attempt_count: { bsonType: ['int', 'long'], minimum: 0 },
        template_data: {
          bsonType: 'object',
          required: [
            'business_name',
            'business_logo_url',
            'business_phone',
            'business_email',
            'business_website',
            'customer_name',
            'provider_name',
            'provider_photo_url',
            'service_name',
            'starts_at',
            'ends_at',
            'timezone',
            'location_mode',
          ],
          properties: {
            starts_at: { bsonType: 'date' },
            ends_at: { bsonType: 'date' },
            location_mode: { enum: ['provider_location', 'customer_location', 'virtual'] },
          },
        },
      },
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
        'slot_cadence_minutes',
        'currency',
        'publicly_bookable',
        'public_display_order',
        'public_booking_policy',
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
        slot_cadence_minutes: {
          bsonType: ['int', 'long', 'null'],
          enum: [5, 10, 15, 20, 30, 60, null],
        },
        currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
        publicly_bookable: { bsonType: 'bool' },
        public_display_order: { bsonType: ['int', 'long'], minimum: 0, maximum: 100000 },
        public_booking_policy: {
          bsonType: 'object',
          required: ['minimum_lead_minutes', 'maximum_advance_days'],
          properties: {
            minimum_lead_minutes: {
              bsonType: ['int', 'long', 'null'],
              minimum: 0,
              maximum: 43200,
            },
            maximum_advance_days: {
              bsonType: ['int', 'long', 'null'],
              minimum: 1,
              maximum: 365,
            },
          },
        },
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
        'buffer_before_minutes',
        'buffer_after_minutes',
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
        buffer_before_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 1440 },
        buffer_after_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 1440 },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        created_by: { bsonType: 'objectId' },
        updated_by: { bsonType: 'objectId' },
      },
    },
  },
  provider_availability_schedules: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'provider_id',
        'timezone',
        'weekly_hours',
        'breaks',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        tenant_id: { bsonType: 'objectId' },
        provider_id: { bsonType: 'objectId' },
        timezone: { bsonType: 'string', minLength: 1, maxLength: 100 },
        weekly_hours: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['day_of_week', 'start_minute', 'end_minute'],
            properties: {
              day_of_week: { bsonType: ['int', 'long'], minimum: 1, maximum: 7 },
              start_minute: { bsonType: ['int', 'long'], minimum: 0, maximum: 1439 },
              end_minute: { bsonType: ['int', 'long'], minimum: 1, maximum: 1440 },
            },
          },
        },
        breaks: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['day_of_week', 'start_minute', 'end_minute'],
            properties: {
              day_of_week: { bsonType: ['int', 'long'], minimum: 1, maximum: 7 },
              start_minute: { bsonType: ['int', 'long'], minimum: 0, maximum: 1439 },
              end_minute: { bsonType: ['int', 'long'], minimum: 1, maximum: 1440 },
            },
          },
        },
        version: { bsonType: ['int', 'long'], minimum: 1 },
      },
    },
  },
  availability_exceptions: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'scope',
        'provider_id',
        'kind',
        'name',
        'all_day',
        'timezone',
        'starts_on',
        'ends_before',
        'starts_at',
        'ends_at',
        'status',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        tenant_id: { bsonType: 'objectId' },
        provider_id: { bsonType: ['objectId', 'null'] },
        scope: { enum: ['tenant', 'provider'] },
        kind: { enum: ['holiday', 'closure', 'time_off'] },
        name: { bsonType: ['string', 'null'], maxLength: 160 },
        all_day: { bsonType: 'bool' },
        timezone: { bsonType: 'string' },
        starts_on: { bsonType: ['string', 'null'] },
        ends_before: { bsonType: ['string', 'null'] },
        starts_at: { bsonType: ['date', 'null'] },
        ends_at: { bsonType: ['date', 'null'] },
        status: { enum: ['active', 'inactive'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
      },
    },
  },
  customers: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'first_name',
        'last_name',
        'preferred_name',
        'first_name_normalized',
        'last_name_normalized',
        'full_name_normalized',
        'email_normalized',
        'mobile_phone_e164',
        'mobile_phone_digits',
        'addresses',
        'communication_preferences',
        'source',
        'external_references',
        'status',
        'deactivated_at',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        public_id: { bsonType: 'string' },
        tenant_id: { bsonType: 'objectId' },
        first_name: { bsonType: 'string', minLength: 1, maxLength: 100 },
        last_name: { bsonType: ['string', 'null'], maxLength: 100 },
        preferred_name: { bsonType: ['string', 'null'], maxLength: 100 },
        first_name_normalized: { bsonType: 'string', minLength: 1, maxLength: 100 },
        last_name_normalized: { bsonType: ['string', 'null'], maxLength: 100 },
        full_name_normalized: { bsonType: 'string', minLength: 1, maxLength: 201 },
        email_normalized: { bsonType: ['string', 'null'], maxLength: 320 },
        mobile_phone_e164: { bsonType: ['string', 'null'], pattern: '^\\+[1-9][0-9]{1,14}$' },
        mobile_phone_digits: { bsonType: ['string', 'null'], pattern: '^[0-9]{2,15}$' },
        addresses: {
          bsonType: 'array',
          maxItems: 5,
          items: {
            bsonType: 'object',
            required: [
              'public_id',
              'label',
              'line_1',
              'line_2',
              'city',
              'region',
              'postal_code',
              'country_code',
              'is_primary',
            ],
            properties: {
              public_id: { bsonType: 'string' },
              label: { enum: ['home', 'work', 'other'] },
              line_1: { bsonType: 'string', minLength: 1, maxLength: 200 },
              line_2: { bsonType: ['string', 'null'], maxLength: 200 },
              city: { bsonType: 'string', minLength: 1, maxLength: 200 },
              region: { bsonType: 'string', minLength: 1, maxLength: 200 },
              postal_code: { bsonType: 'string', minLength: 1, maxLength: 32 },
              country_code: { bsonType: 'string', pattern: '^[A-Z]{2}$' },
              is_primary: { bsonType: 'bool' },
            },
          },
        },
        communication_preferences: {
          bsonType: 'object',
          required: ['preferred_channel', 'marketing_email', 'marketing_sms'],
          properties: {
            preferred_channel: { enum: ['email', 'sms', 'phone', 'none', null] },
            marketing_email: { enum: ['unknown', 'opted_in', 'opted_out'] },
            marketing_sms: { enum: ['unknown', 'opted_in', 'opted_out'] },
          },
        },
        source: { enum: ['manual', 'seed', 'import', 'public_booking', 'partner_api'] },
        external_references: {
          bsonType: 'array',
          maxItems: 20,
          items: {
            bsonType: 'object',
            required: ['system', 'external_id', 'recorded_at'],
            properties: {
              system: { bsonType: 'string', minLength: 1, maxLength: 64 },
              external_id: { bsonType: 'string', minLength: 1, maxLength: 255 },
              recorded_at: { bsonType: 'date' },
            },
          },
        },
        status: { enum: ['active', 'inactive'] },
        deactivated_at: { bsonType: ['date', 'null'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        created_by: { bsonType: ['objectId', 'null'] },
        updated_by: { bsonType: ['objectId', 'null'] },
      },
    },
  },
  appointments: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'reference',
        'tenant_id',
        'customer_id',
        'provider_id',
        'service_id',
        'provider_service_assignment_id',
        'starts_at',
        'ends_at',
        'blocked_starts_at',
        'blocked_ends_at',
        'timezone',
        'local_start_date',
        'snapshot',
        'location',
        'status',
        'source',
        'public_submission',
        'booking_terms',
        'cancelled_at',
        'cancelled_by',
        'cancellation_reason',
        'cancellation_detail',
        'completed_at',
        'completed_by',
        'no_show_at',
        'no_show_by',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      properties: {
        public_id: { bsonType: 'string' },
        reference: { bsonType: 'string', pattern: '^BNT-[A-F0-9]{8}$' },
        tenant_id: { bsonType: 'objectId' },
        customer_id: { bsonType: 'objectId' },
        provider_id: { bsonType: 'objectId' },
        service_id: { bsonType: 'objectId' },
        provider_service_assignment_id: { bsonType: 'objectId' },
        starts_at: { bsonType: 'date' },
        ends_at: { bsonType: 'date' },
        blocked_starts_at: { bsonType: 'date' },
        blocked_ends_at: { bsonType: 'date' },
        timezone: { bsonType: 'string', minLength: 1, maxLength: 100 },
        local_start_date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        snapshot: {
          bsonType: 'object',
          required: [
            'customer_display_name',
            'provider_display_name',
            'service_name',
            'service_duration_minutes',
            'slot_cadence_minutes',
            'buffer_before_minutes',
            'buffer_after_minutes',
            'delivery_mode',
            'base_price_minor',
            'booking_fee_minor',
            'currency',
            'customer_note',
          ],
          properties: {
            customer_display_name: { bsonType: 'string', minLength: 1, maxLength: 201 },
            provider_display_name: { bsonType: 'string', minLength: 1, maxLength: 160 },
            service_name: { bsonType: 'string', minLength: 1, maxLength: 160 },
            service_duration_minutes: { bsonType: ['int', 'long'], minimum: 5, maximum: 1440 },
            slot_cadence_minutes: { bsonType: ['int', 'long'], minimum: 5, maximum: 1440 },
            buffer_before_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 1440 },
            buffer_after_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 1440 },
            delivery_mode: { enum: ['provider_location', 'customer_location', 'virtual'] },
            base_price_minor: { bsonType: ['int', 'long'], minimum: 0 },
            booking_fee_minor: { bsonType: ['int', 'long'], minimum: 0 },
            currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
            customer_note: { bsonType: ['string', 'null'], maxLength: 1000 },
          },
        },
        location: {
          bsonType: 'object',
          required: ['mode', 'customer_address'],
          properties: {
            mode: { enum: ['provider_location', 'customer_location', 'virtual'] },
            customer_address: {
              bsonType: ['object', 'null'],
            },
          },
        },
        status: { enum: ['scheduled', 'completed', 'cancelled', 'no_show'] },
        source: { enum: ['business_hub', 'seed', 'public_booking'] },
        public_submission: {
          bsonType: ['object', 'null'],
          required: ['idempotency_key_hash', 'request_fingerprint'],
          properties: {
            idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        },
        booking_terms: {
          bsonType: ['object', 'null'],
          required: ['version', 'accepted_at'],
          properties: {
            version: { bsonType: 'string', minLength: 1, maxLength: 64 },
            accepted_at: { bsonType: 'date' },
          },
        },
        cancelled_at: { bsonType: ['date', 'null'] },
        cancelled_by: { bsonType: ['objectId', 'null'] },
        cancellation_reason: {
          enum: [
            'customer_request',
            'provider_unavailable',
            'business_closed',
            'duplicate',
            'other',
            null,
          ],
        },
        cancellation_detail: { bsonType: ['string', 'null'], maxLength: 500 },
        completed_at: { bsonType: ['date', 'null'] },
        completed_by: { bsonType: ['objectId', 'null'] },
        no_show_at: { bsonType: ['date', 'null'] },
        no_show_by: { bsonType: ['objectId', 'null'] },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        created_by: { bsonType: ['objectId', 'null'] },
        updated_by: { bsonType: ['objectId', 'null'] },
      },
      oneOf: [
        {
          properties: {
            source: { enum: ['business_hub', 'seed'] },
            public_submission: { bsonType: 'null' },
            booking_terms: { bsonType: 'null' },
            created_by: { bsonType: 'objectId' },
            updated_by: { bsonType: 'objectId' },
          },
        },
        {
          properties: {
            source: { enum: ['public_booking'] },
            public_submission: { bsonType: 'object' },
            booking_terms: { bsonType: 'object' },
            created_by: { bsonType: 'null' },
            updated_by: { bsonType: 'null' },
          },
        },
      ],
    },
  },
  appointment_schedule_locks: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['tenant_id', 'provider_id', 'utc_date', 'revision', 'updated_at'],
      properties: {
        tenant_id: { bsonType: 'objectId' },
        provider_id: { bsonType: 'objectId' },
        utc_date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        revision: { bsonType: ['int', 'long'], minimum: 0 },
        updated_at: { bsonType: 'date' },
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
          default_slot_cadence_minutes: { $ifNull: ['$default_slot_cadence_minutes', 15] },
          locale: { $ifNull: ['$locale', 'en-US'] },
          currency: { $ifNull: ['$currency', 'USD'] },
          version: { $ifNull: ['$version', 1] },
          updated_by: { $ifNull: ['$updated_by', null] },
          public_booking_enabled: { $ifNull: ['$public_booking_enabled', false] },
          public_profile: {
            $ifNull: [
              '$public_profile',
              {
                business_name: '$display_name',
                description: null,
                tagline: null,
                logo_url: null,
                primary_color: null,
                website_url: null,
                phone_e164: null,
                email_normalized: null,
              },
            ],
          },
          booking_policy: {
            $ifNull: ['$booking_policy', { minimum_lead_minutes: 120, maximum_advance_days: 90 }],
          },
          public_booking_terms: {
            $ifNull: [
              '$public_booking_terms',
              {
                version: '1',
                acknowledgment_label: 'I agree to the booking and cancellation terms.',
                terms_url: null,
              },
            ],
          },
          appointment_email_settings: {
            $ifNull: [
              '$appointment_email_settings',
              { enabled: false, sender_name: '$display_name', reply_to_email: null },
            ],
          },
        },
      },
    ]);
  }
  if (existing.has('services')) {
    await db.collection('services').updateMany({}, [
      {
        $set: {
          slot_cadence_minutes: { $ifNull: ['$slot_cadence_minutes', null] },
          publicly_bookable: { $ifNull: ['$publicly_bookable', false] },
          public_display_order: { $ifNull: ['$public_display_order', 0] },
          public_booking_policy: {
            $ifNull: [
              '$public_booking_policy',
              { minimum_lead_minutes: null, maximum_advance_days: null },
            ],
          },
        },
      },
    ]);
  }
  if (existing.has('appointments')) {
    await db.collection('appointments').updateMany({}, [
      {
        $set: {
          'snapshot.customer_note': { $ifNull: ['$snapshot.customer_note', null] },
          public_submission: { $ifNull: ['$public_submission', null] },
          booking_terms: { $ifNull: ['$booking_terms', null] },
        },
      },
    ]);
  }
  if (existing.has('provider_service_assignments')) {
    await db.collection('provider_service_assignments').updateMany(
      {
        $or: [
          { buffer_before_minutes: { $exists: false } },
          { buffer_after_minutes: { $exists: false } },
        ],
      },
      [
        {
          $set: {
            buffer_before_minutes: { $ifNull: ['$buffer_before_minutes', 0] },
            buffer_after_minutes: { $ifNull: ['$buffer_after_minutes', 0] },
          },
        },
      ],
    );
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
    {
      key: {
        tenant_id: 1,
        publicly_bookable: 1,
        status: 1,
        public_display_order: 1,
        name: 1,
        public_id: 1,
      },
      name: 'services_public_catalog',
    },
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
    {
      key: {
        tenant_id: 1,
        status: 1,
        customer_selectable: 1,
        accepting_new_clients: 1,
        display_order: 1,
        display_name: 1,
        public_id: 1,
      },
      name: 'providers_public_directory',
    },
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
  await db.collection('provider_availability_schedules').createIndexes([
    {
      key: { tenant_id: 1, provider_id: 1 },
      name: 'availability_schedule_tenant_provider_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'availability_schedule_tenant_public_id_unique',
      unique: true,
    },
  ]);
  await db.collection('availability_exceptions').createIndexes([
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'availability_exception_tenant_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, scope: 1, provider_id: 1, status: 1, starts_at: 1, ends_at: 1 },
      name: 'availability_exception_timed_lookup',
    },
    {
      key: { tenant_id: 1, scope: 1, provider_id: 1, status: 1, starts_on: 1, ends_before: 1 },
      name: 'availability_exception_date_lookup',
    },
  ]);
  await db.collection('customers').createIndexes([
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'customers_tenant_public_id_unique',
      unique: true,
    },
    {
      key: {
        tenant_id: 1,
        status: 1,
        last_name_normalized: 1,
        first_name_normalized: 1,
        public_id: 1,
      },
      name: 'customers_directory',
    },
    {
      key: { tenant_id: 1, email_normalized: 1, public_id: 1 },
      name: 'customers_email_lookup',
    },
    {
      key: { tenant_id: 1, mobile_phone_e164: 1, public_id: 1 },
      name: 'customers_phone_lookup',
    },
    {
      key: { tenant_id: 1, first_name_normalized: 1, public_id: 1 },
      name: 'customers_first_name_search',
    },
    {
      key: { tenant_id: 1, full_name_normalized: 1, public_id: 1 },
      name: 'customers_full_name_search',
    },
    {
      key: { tenant_id: 1, updated_at: -1, public_id: 1 },
      name: 'customers_updated',
    },
  ]);
  await db.collection('appointments').createIndexes([
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'appointments_tenant_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, reference: 1 },
      name: 'appointments_tenant_reference_unique',
      unique: true,
    },
    {
      key: {
        tenant_id: 1,
        provider_id: 1,
        status: 1,
        blocked_starts_at: 1,
        blocked_ends_at: 1,
      },
      name: 'appointments_provider_conflicts',
    },
    {
      key: { tenant_id: 1, starts_at: 1, public_id: 1 },
      name: 'appointments_tenant_upcoming',
    },
    {
      key: { tenant_id: 1, starts_at: -1, public_id: -1 },
      name: 'appointments_tenant_past',
    },
    {
      key: { tenant_id: 1, status: 1, starts_at: 1, public_id: 1 },
      name: 'appointments_tenant_status_agenda',
    },
    {
      key: { tenant_id: 1, provider_id: 1, starts_at: 1, public_id: 1 },
      name: 'appointments_tenant_provider_agenda',
    },
    {
      key: { tenant_id: 1, service_id: 1, starts_at: 1, public_id: 1 },
      name: 'appointments_tenant_service_agenda',
    },
    {
      key: { tenant_id: 1, customer_id: 1, starts_at: -1, public_id: -1 },
      name: 'appointments_tenant_customer_agenda',
    },
    {
      key: { tenant_id: 1, 'public_submission.idempotency_key_hash': 1 },
      name: 'appointments_public_idempotency_unique',
      unique: true,
      partialFilterExpression: {
        source: 'public_booking',
        'public_submission.idempotency_key_hash': { $type: 'string' },
      },
    },
  ]);
  await db.collection('appointment_schedule_locks').createIndexes([
    {
      key: { tenant_id: 1, provider_id: 1, utc_date: 1 },
      name: 'appointment_schedule_locks_scope_unique',
      unique: true,
    },
    { key: { updated_at: 1 }, name: 'appointment_schedule_locks_updated' },
  ]);
  await db.collection('notification_outbox').createIndexes([
    { key: { public_id: 1 }, name: 'notification_outbox_public_id_unique', unique: true },
    {
      key: { status: 1, next_attempt_at: 1, created_at: 1 },
      name: 'notification_outbox_worker_poll',
    },
    {
      key: { tenant_id: 1, appointment_id: 1, created_at: -1 },
      name: 'notification_outbox_appointment_history',
    },
  ]);
}
