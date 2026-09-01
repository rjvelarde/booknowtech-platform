import type { Db, Document } from 'mongodb';
import { PLATFORM_TENANT_DEFAULTS, fallbackBookingOrigin } from '@booknowtech/shared';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const DNS_LABEL_PATTERN = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_PATTERN = `${DNS_LABEL_PATTERN}(?:\\.${DNS_LABEL_PATTERN})+`;

const validators: Record<string, Document> = {
  booknowtech_connect_terms_acceptances: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'terms_version',
        'accepted_at',
        'accepted_by_user_id',
        'accepted_by_membership_id',
        'accepted_request_id',
        'accepted_ip_hash',
        'acceptance_text_hash',
        'created_at',
      ],
      properties: {
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        terms_version: { bsonType: 'string', minLength: 1, maxLength: 80 },
        accepted_at: { bsonType: 'date' },
        accepted_by_user_id: { bsonType: 'objectId' },
        accepted_by_membership_id: { bsonType: 'objectId' },
        accepted_request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        accepted_ip_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        acceptance_text_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        created_at: { bsonType: 'date' },
      },
    },
  },
  tenant_stripe_accounts: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'stripe_account_id',
        'account_type',
        'country',
        'default_currency',
        'status',
        'active',
        'details_submitted',
        'charges_enabled',
        'payouts_enabled',
        'capabilities',
        'requirements',
        'last_stripe_event_id',
        'last_stripe_event_created_at',
        'last_synced_at',
        'connected_at',
        'disconnected_at',
        'created_at',
        'created_by_user_id',
        'updated_at',
        'updated_by_source',
        'version',
      ],
      properties: {
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        stripe_account_id: { bsonType: 'string', pattern: '^acct_[A-Za-z0-9]+$' },
        account_type: { enum: ['express'] },
        country: { enum: ['US'] },
        default_currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
        status: {
          enum: [
            'onboarding_started',
            'pending_verification',
            'action_required',
            'restricted',
            'payments_enabled',
            'payouts_enabled',
            'disabled',
            'disconnected',
          ],
        },
        active: { bsonType: 'bool' },
        details_submitted: { bsonType: 'bool' },
        charges_enabled: { bsonType: 'bool' },
        payouts_enabled: { bsonType: 'bool' },
        capabilities: { bsonType: 'object' },
        requirements: { bsonType: 'object' },
        last_stripe_event_id: { bsonType: ['string', 'null'] },
        last_stripe_event_created_at: { bsonType: ['date', 'null'] },
        last_synced_at: { bsonType: ['date', 'null'] },
        connected_at: { bsonType: 'date' },
        disconnected_at: { bsonType: ['date', 'null'] },
        created_at: { bsonType: 'date' },
        created_by_user_id: { bsonType: 'objectId' },
        updated_at: { bsonType: 'date' },
        updated_by_source: {
          enum: ['user', 'stripe_webhook', 'stripe_api_refresh', 'reconciliation'],
        },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        readiness_generation: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        readiness_refresh_token: { bsonType: ['string', 'null'] },
        readiness_refresh_started_at: { bsonType: ['date', 'null'] },
        last_readiness_refresh_attempt_at: { bsonType: ['date', 'null'] },
        last_readiness_refresh_failure_category: { bsonType: ['string', 'null'] },
      },
    },
  },
  stripe_connect_operations: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'request_id',
        'operation_type',
        'request_fingerprint',
        'stripe_idempotency_key',
        'status',
        'stripe_account_id',
        'result_reference',
        'failure_category',
        'created_by_user_id',
        'created_at',
        'completed_at',
      ],
    },
  },
  stripe_webhook_events: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'stripe_event_id',
        'endpoint_kind',
        'stripe_account_id',
        'tenant_id',
        'event_type',
        'stripe_created_at',
        'stripe_api_version',
        'livemode',
        'payload_hash',
        'sanitized_payload',
        'processing_status',
        'attempt_count',
        'next_attempt_at',
        'processing_started_at',
        'processed_at',
        'failure_category',
        'received_request_id',
        'received_at',
        'updated_at',
      ],
      properties: {
        processing_token: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
      },
    },
  },
  stripe_webhook_failure_acknowledgements: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'stripe_webhook_event_id',
        'stripe_event_id',
        'failure_category',
        'operator_id',
        'reason',
        'request_id',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        stripe_webhook_event_id: { bsonType: 'objectId' },
        stripe_event_id: { bsonType: 'string', pattern: '^evt_[A-Za-z0-9]+$' },
        failure_category: { bsonType: 'string', minLength: 1, maxLength: 120 },
        operator_id: { bsonType: 'string', minLength: 3, maxLength: 120 },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        request_id: { bsonType: 'string', pattern: UUID_PATTERN },
        created_at: { bsonType: 'date' },
      },
    },
  },
  tenant_payment_execution_settings: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'tenant_id',
        'enabled',
        'currency',
        'approved_by_operator_id',
        'approval_request_id',
        'updated_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        tenant_id: { bsonType: 'objectId' },
        enabled: { bsonType: 'bool' },
        currency: { enum: ['USD'] },
        approved_by_operator_id: { bsonType: 'string', minLength: 3, maxLength: 120 },
        approval_request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        updated_at: { bsonType: 'date' },
      },
    },
  },
  tenant_booking_fee_versions: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'version',
        'amount_minor',
        'currency',
        'operator_id',
        'reason',
        'request_id',
        'idempotency_key_hash',
        'request_fingerprint',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
        currency: { enum: ['USD'] },
        operator_id: { bsonType: 'string', minLength: 3, maxLength: 120 },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        created_at: { bsonType: 'date' },
      },
    },
  },
  tenant_booking_fee_active: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'tenant_id',
        'fee_version_id',
        'fee_version_public_id',
        'version',
        'amount_minor',
        'currency',
        'activated_at',
        'activated_by_operator_id',
        'activation_request_id',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        tenant_id: { bsonType: 'objectId' },
        fee_version_id: { bsonType: 'objectId' },
        fee_version_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
        currency: { enum: ['USD'] },
        activated_at: { bsonType: 'date' },
        activated_by_operator_id: { bsonType: 'string', minLength: 3, maxLength: 120 },
        activation_request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
      },
    },
  },
  service_payment_configuration_versions: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'service_id',
        'service_public_id',
        'version',
        'payment_mode',
        'fixed_deposit_minor',
        'currency',
        'request_id',
        'idempotency_key_hash',
        'request_fingerprint',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        service_id: { bsonType: 'objectId' },
        service_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        payment_mode: { enum: ['none', 'fixed_deposit', 'full'] },
        fixed_deposit_minor: { bsonType: ['int', 'long', 'null'], minimum: 1 },
        currency: { enum: ['USD'] },
        request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        changed_by_user_id: { bsonType: 'objectId' },
        changed_by_membership_id: { bsonType: 'objectId' },
        changed_by_operator_id: {
          bsonType: 'string',
          minLength: 3,
          maxLength: 120,
          pattern: '^[a-z0-9][a-z0-9._@+-]*$',
        },
        created_at: { bsonType: 'date' },
      },
      allOf: [
        {
          oneOf: [
            {
              properties: {
                payment_mode: { enum: ['none', 'full'] },
                fixed_deposit_minor: { bsonType: 'null' },
              },
            },
            {
              properties: {
                payment_mode: { enum: ['fixed_deposit'] },
                fixed_deposit_minor: { bsonType: ['int', 'long'], minimum: 1 },
              },
            },
          ],
        },
        {
          oneOf: [
            { required: ['changed_by_user_id', 'changed_by_membership_id'] },
            { required: ['changed_by_operator_id'] },
          ],
        },
      ],
    },
  },
  service_payment_configuration_active: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'tenant_id',
        'service_id',
        'configuration_version_id',
        'configuration_public_id',
        'version',
        'payment_mode',
        'fixed_deposit_minor',
        'currency',
        'activated_at',
        'activation_request_id',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        tenant_id: { bsonType: 'objectId' },
        service_id: { bsonType: 'objectId' },
        configuration_version_id: { bsonType: 'objectId' },
        configuration_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        version: { bsonType: ['int', 'long'], minimum: 1 },
        payment_mode: { enum: ['none', 'fixed_deposit', 'full'] },
        fixed_deposit_minor: { bsonType: ['int', 'long', 'null'], minimum: 1 },
        currency: { enum: ['USD'] },
        activated_at: { bsonType: 'date' },
        activation_request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
      },
      oneOf: [
        {
          properties: {
            payment_mode: { enum: ['none', 'full'] },
            fixed_deposit_minor: { bsonType: 'null' },
          },
        },
        {
          properties: {
            payment_mode: { enum: ['fixed_deposit'] },
            fixed_deposit_minor: { bsonType: ['int', 'long'], minimum: 1 },
          },
        },
      ],
    },
  },
  provisional_payment_customers: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'first_name',
        'last_name',
        'email_normalized',
        'mobile_phone_e164',
        'customer_input_hash',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        first_name: { bsonType: 'string', minLength: 1, maxLength: 100 },
        last_name: { bsonType: 'string', minLength: 1, maxLength: 100 },
        email_normalized: { bsonType: 'string', minLength: 3, maxLength: 320 },
        mobile_phone_e164: { bsonType: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
        customer_input_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        created_at: { bsonType: 'date' },
      },
    },
  },
  payment_attempts: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'appointment_id',
        'customer_id',
        'customer_email_normalized',
        'tenant_stripe_account_public_id',
        'idempotency_key_hash',
        'request_fingerprint',
        'client_request_fingerprint',
        'public_booking_origin',
        'amount_snapshot',
        'configuration_snapshot',
        'payment_terms_acceptance',
        'stripe_payment_intent_id',
        'stripe_payment_intent_status',
        'state',
        'expires_at',
        'slot_released',
        'claim_token',
        'claim_started_at',
        'attempt_count',
        'next_attempt_at',
        'failure_category',
        'request_id',
        'correlation_id',
        'created_at',
        'updated_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        appointment_id: { bsonType: 'objectId' },
        customer_id: { bsonType: 'objectId' },
        customer_email_normalized: {
          bsonType: 'string',
          minLength: 3,
          maxLength: 320,
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        },
        tenant_stripe_account_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        client_request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        public_booking_origin: {
          bsonType: ['string', 'null'],
          maxLength: 262,
          pattern: `^https://${HOSTNAME_PATTERN}$`,
        },
        recovery_token_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        recovery_hostname_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        recovery_expires_at: { bsonType: 'date' },
        amount_snapshot: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'service_price_minor',
            'payment_mode',
            'fixed_deposit_minor',
            'provider_amount_due_now_minor',
            'booknowtech_fee_minor',
            'customer_total_due_now_minor',
            'application_fee_amount_minor',
            'remaining_service_balance_minor',
            'currency',
          ],
          properties: {
            service_price_minor: { bsonType: ['int', 'long'], minimum: 1 },
            payment_mode: { enum: ['fixed_deposit', 'full'] },
            fixed_deposit_minor: { bsonType: ['int', 'long', 'null'], minimum: 1 },
            provider_amount_due_now_minor: { bsonType: ['int', 'long'], minimum: 1 },
            booknowtech_fee_minor: { bsonType: ['int', 'long'], minimum: 0 },
            customer_total_due_now_minor: { bsonType: ['int', 'long'], minimum: 1 },
            application_fee_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
            remaining_service_balance_minor: { bsonType: ['int', 'long'], minimum: 0 },
            currency: { enum: ['USD'] },
          },
        },
        configuration_snapshot: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'service_payment_configuration_public_id',
            'service_payment_configuration_version',
            'deposit_version_public_id',
            'fee_configuration_public_id',
            'fee_version',
          ],
          properties: {
            service_payment_configuration_public_id: {
              bsonType: 'string',
              pattern: UUID_PATTERN,
            },
            service_payment_configuration_version: { bsonType: ['int', 'long'], minimum: 1 },
            deposit_version_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
            fee_configuration_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
            fee_version: { bsonType: ['int', 'long'], minimum: 1 },
          },
        },
        payment_terms_acceptance: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'version',
            'document_sha256',
            'accepted_at',
            'request_id',
            'payment_attempt_public_id',
            'idempotency_key_hash',
            'ip_hash',
          ],
          properties: {
            version: { bsonType: 'string', minLength: 1, maxLength: 80 },
            document_sha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            accepted_at: { bsonType: 'date' },
            request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
            payment_attempt_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
            idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            ip_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        },
        stripe_payment_intent_id: { bsonType: ['string', 'null'], pattern: '^pi_[A-Za-z0-9]+$' },
        stripe_payment_intent_status: {
          enum: [
            null,
            'requires_payment_method',
            'requires_confirmation',
            'requires_action',
            'processing',
            'canceled',
            'succeeded',
          ],
        },
        state: {
          enum: [
            'requested',
            'stripe_creation_processing',
            'requires_payment_method',
            'requires_customer_action',
            'processing',
            'succeeded_unfinalized',
            'succeeded',
            'failed_recoverable',
            'failed_terminal',
            'expired',
            'stale',
            'manual_review',
          ],
        },
        expires_at: { bsonType: 'date' },
        slot_released: { bsonType: 'bool' },
        claim_token: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        claim_started_at: { bsonType: ['date', 'null'] },
        attempt_count: { bsonType: ['int', 'long'], minimum: 0, maximum: 100 },
        next_attempt_at: { bsonType: 'date' },
        failure_category: {
          enum: [
            null,
            'stripe_creation',
            'card_declined',
            'terminal_payment',
            'expired',
            'stale',
            'local_finalization',
            'unknown',
          ],
        },
        reconciliation_requeue_request_id: {
          bsonType: ['string', 'null'],
          minLength: 1,
          maxLength: 128,
        },
        request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        correlation_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
      },
    },
  },
  payment_ledger_entries: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'appointment_id',
        'payment_attempt_id',
        'entry_kind',
        'sequence',
        'currency',
        'service_price_minor',
        'provider_amount_due_now_minor',
        'booknowtech_fee_minor',
        'customer_total_due_now_minor',
        'application_fee_amount_minor',
        'remaining_service_balance_minor',
        'source_identity',
        'source_idempotency_key',
        'stripe_object_id',
        'stripe_event_id',
        'effective_at',
        'request_id',
        'correlation_id',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        appointment_id: { bsonType: 'objectId' },
        payment_attempt_id: { bsonType: 'objectId' },
        entry_kind: {
          enum: [
            'intent_requested',
            'payment_succeeded',
            'payment_failed_recoverable',
            'payment_processing',
            'payment_failed_terminal',
            'payment_expired',
            'payment_stale',
            'refund_created_external',
            'refund_updated_external',
            'refund_failed_external',
            'dispute_evidence',
            'manual_review',
            'reconciliation',
          ],
        },
        sequence: { bsonType: ['int', 'long'], minimum: 1 },
        currency: { enum: ['USD'] },
        service_price_minor: { bsonType: ['int', 'long'], minimum: 0 },
        provider_amount_due_now_minor: { bsonType: ['int', 'long'], minimum: 0 },
        booknowtech_fee_minor: { bsonType: ['int', 'long'], minimum: 0 },
        customer_total_due_now_minor: { bsonType: ['int', 'long'], minimum: 0 },
        application_fee_amount_minor: { bsonType: ['int', 'long'], minimum: 0 },
        remaining_service_balance_minor: { bsonType: ['int', 'long'], minimum: 0 },
        source_identity: { bsonType: 'string', minLength: 1, maxLength: 160 },
        source_idempotency_key: { bsonType: 'string', minLength: 1, maxLength: 200 },
        stripe_object_id: { bsonType: ['string', 'null'], maxLength: 255 },
        stripe_event_id: { bsonType: ['string', 'null'], maxLength: 255 },
        effective_at: { bsonType: 'date' },
        request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        correlation_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        created_at: { bsonType: 'date' },
      },
    },
  },
  payment_reconciliation_requeues: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'payment_attempt_id',
        'payment_attempt_public_id',
        'tenant_id',
        'operator_id',
        'reason',
        'request_id',
        'environment',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        payment_attempt_id: { bsonType: 'objectId' },
        payment_attempt_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        operator_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        request_id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        environment: { enum: ['staging', 'production'] },
        created_at: { bsonType: 'date' },
      },
    },
  },
  payment_operations_alerts: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'payment_attempt_id',
        'payment_attempt_public_id',
        'category',
        'priority',
        'resolution_target',
        'status',
        'reason',
        'created_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        payment_attempt_id: { bsonType: 'objectId' },
        payment_attempt_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        category: { enum: ['reconciliation_actionable'] },
        priority: { enum: ['highest', 'standard'] },
        resolution_target: { enum: ['one_hour_during_operating_hours', 'same_business_day'] },
        status: { enum: ['open', 'acknowledged'] },
        reason: { bsonType: 'string', minLength: 1, maxLength: 160 },
        created_at: { bsonType: 'date' },
        acknowledged_at: { bsonType: 'date' },
      },
    },
  },
  payment_configuration_operations: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'request_id',
        'operation_type',
        'request_fingerprint',
        'operator_id',
        'reason',
        'environment',
        'tenant_public_id',
        'service_public_id',
        'status',
        'result',
        'created_at',
        'completed_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        request_id: { bsonType: 'string', pattern: UUID_PATTERN },
        operation_type: {
          enum: ['activate_booking_fee', 'activate_service_configuration', 'set_tenant_execution'],
        },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        operator_id: {
          bsonType: 'string',
          minLength: 3,
          maxLength: 120,
          pattern: '^[a-z0-9][a-z0-9._@+-]*$',
        },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        environment: { enum: ['staging', 'production'] },
        tenant_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        service_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        status: { enum: ['completed'] },
        result: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['version', 'public_id', 'enabled', 'payment_mode', 'amount_minor'],
          properties: {
            version: { bsonType: ['int', 'long', 'null'], minimum: 1 },
            public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
            enabled: { bsonType: ['bool', 'null'] },
            payment_mode: { enum: [null, 'none', 'fixed_deposit', 'full'] },
            amount_minor: { bsonType: ['int', 'long', 'null'], minimum: 0 },
          },
        },
        created_at: { bsonType: 'date' },
        completed_at: { bsonType: 'date' },
      },
    },
  },
  tenant_booking_hostnames: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'tenant_id',
        'tenant_public_id',
        'normalized_hostname',
        'type',
        'environment',
        'status',
        'verification_challenge_hash',
        'verification_expires_at',
        'verified_at',
        'railway_mapping_reference',
        'railway_status',
        'tls_status',
        'last_checked_at',
        'failure_code',
        'created_at',
        'created_by',
        'updated_at',
        'updated_by',
        'activated_at',
        'disabled_at',
        'removed_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        tenant_id: { bsonType: 'objectId' },
        tenant_public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        normalized_hostname: {
          bsonType: 'string',
          minLength: 4,
          maxLength: 253,
          pattern: `^${HOSTNAME_PATTERN}$`,
        },
        type: { enum: ['custom'] },
        environment: { enum: ['staging', 'production'] },
        status: {
          enum: [
            'pending_verification',
            'verified',
            'provisioning',
            'active',
            'failed',
            'disabled',
            'removing',
            'removed',
          ],
        },
        verification_challenge_hash: {
          bsonType: ['string', 'null'],
          pattern: '^[a-f0-9]{64}$',
        },
        verification_expires_at: { bsonType: ['date', 'null'] },
        verified_at: { bsonType: ['date', 'null'] },
        railway_mapping_reference: { bsonType: ['string', 'null'], maxLength: 200 },
        railway_status: { bsonType: ['string', 'null'], maxLength: 80 },
        tls_status: { bsonType: ['string', 'null'], maxLength: 80 },
        last_checked_at: { bsonType: ['date', 'null'] },
        failure_code: {
          bsonType: ['string', 'null'],
          maxLength: 80,
          pattern: '^[a-z0-9][a-z0-9_]*$',
        },
        created_at: { bsonType: 'date' },
        created_by: { bsonType: 'string', minLength: 3, maxLength: 120 },
        updated_at: { bsonType: 'date' },
        updated_by: { bsonType: 'string', minLength: 3, maxLength: 120 },
        activated_at: { bsonType: ['date', 'null'] },
        disabled_at: { bsonType: ['date', 'null'] },
        removed_at: { bsonType: ['date', 'null'] },
      },
    },
  },
  tenant_booking_hostname_operations: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'request_id',
        'operation_type',
        'request_fingerprint',
        'operator_id',
        'reason',
        'environment',
        'hostname_public_id',
        'tenant_public_id',
        'normalized_hostname',
        'status',
        'previous_state',
        'new_state',
        'failure_category',
        'result',
        'created_at',
        'completed_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        request_id: { bsonType: 'string', pattern: UUID_PATTERN },
        operation_type: {
          enum: [
            'issue_challenge',
            'verify',
            'begin_provisioning',
            'activate',
            'deactivate',
            'begin_removal',
            'complete_removal',
          ],
        },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        operator_id: {
          bsonType: 'string',
          minLength: 3,
          maxLength: 120,
          pattern: '^[a-z0-9][a-z0-9._@+-]*$',
        },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        environment: { enum: ['staging', 'production'] },
        hostname_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        tenant_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        normalized_hostname: {
          bsonType: 'string',
          minLength: 4,
          maxLength: 253,
          pattern: `^${HOSTNAME_PATTERN}$`,
        },
        status: { enum: ['completed', 'refused', 'failed'] },
        previous_state: {
          enum: [
            null,
            'pending_verification',
            'verified',
            'provisioning',
            'active',
            'failed',
            'disabled',
            'removing',
            'removed',
          ],
        },
        new_state: {
          enum: [
            null,
            'pending_verification',
            'verified',
            'provisioning',
            'active',
            'failed',
            'disabled',
            'removing',
            'removed',
          ],
        },
        failure_category: {
          bsonType: ['string', 'null'],
          maxLength: 80,
          pattern: '^[a-z0-9][a-z0-9_]*$',
        },
        result: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'txt_record_name',
            'operator_attested_railway_mapping_reference',
            'operator_attested_railway_status',
            'operator_attested_tls_status',
          ],
          properties: {
            txt_record_name: { bsonType: ['string', 'null'], maxLength: 253 },
            operator_attested_railway_mapping_reference: {
              bsonType: ['string', 'null'],
              maxLength: 200,
            },
            operator_attested_railway_status: {
              bsonType: ['string', 'null'],
              maxLength: 80,
            },
            operator_attested_tls_status: {
              bsonType: ['string', 'null'],
              maxLength: 80,
            },
          },
        },
        created_at: { bsonType: 'date' },
        completed_at: { bsonType: 'date' },
      },
    },
  },
  service_heartbeats: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'service',
        'environment',
        'commit_sha',
        'instance_id',
        'observed_at',
        'expires_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        service: { enum: ['worker'] },
        environment: { enum: ['development', 'test', 'staging', 'production'] },
        commit_sha: { bsonType: 'string', pattern: '^[a-f0-9]{40}$' },
        instance_id: { bsonType: 'string', pattern: UUID_PATTERN },
        observed_at: { bsonType: 'date' },
        expires_at: { bsonType: 'date' },
      },
    },
  },
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
        'designation',
        'public_booking_enabled',
        'public_profile',
        'booking_policy',
        'public_booking_terms',
        'appointment_email_settings',
        'appointment_self_service',
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
        designation: { enum: ['customer', 'internal_qa'] },
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
        appointment_self_service: {
          bsonType: 'object',
          required: ['enabled', 'cancellation_cutoff_minutes', 'reschedule_cutoff_minutes'],
          properties: {
            enabled: { bsonType: 'bool' },
            cancellation_cutoff_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 10080 },
            reschedule_cutoff_minutes: { bsonType: ['int', 'long'], minimum: 0, maximum: 10080 },
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
        'must_change_password',
        'status',
        'created_at',
        'updated_at',
      ],
      properties: {
        must_change_password: { bsonType: 'bool' },
        status: { enum: ['active', 'disabled'] },
      },
    },
  },
  roles: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['public_id', 'tenant_id', 'user_id', 'role', 'status', 'created_at', 'updated_at'],
      properties: {
        role: { enum: ['tenant_owner', 'tenant_admin', 'provider', 'front_desk'] },
        status: { enum: ['active', 'suspended', 'revoked'] },
        suspended_by_tenant_status: { bsonType: 'bool' },
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
        'appointment_access',
        'public_booking_origin',
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
        financial_finalization_key: { bsonType: 'string', minLength: 1, maxLength: 200 },
        public_booking_origin: {
          bsonType: ['string', 'null'],
          maxLength: 262,
          pattern: `^https://${HOSTNAME_PATTERN}$`,
        },
        appointment_access: {
          bsonType: ['object', 'null'],
          required: ['token_public_id', 'generation'],
          properties: {
            token_public_id: { bsonType: 'string', minLength: 1 },
            generation: { bsonType: ['int', 'long'], minimum: 1 },
          },
        },
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
        'public_self_service_policy',
        'status',
        'version',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at',
      ],
      properties: {
        public_self_service_policy: {
          bsonType: 'object',
          required: ['cancellation_cutoff_minutes', 'reschedule_cutoff_minutes'],
          properties: {
            cancellation_cutoff_minutes: {
              bsonType: ['int', 'long', 'null'],
              minimum: 0,
              maximum: 10080,
            },
            reschedule_cutoff_minutes: {
              bsonType: ['int', 'long', 'null'],
              minimum: 0,
              maximum: 10080,
            },
          },
        },
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
        status: {
          enum: [
            'scheduled',
            'completed',
            'cancelled',
            'no_show',
            'payment_pending',
            'payment_failed',
            'payment_expired',
          ],
        },
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
            updated_by: { bsonType: ['objectId', 'null'] },
          },
        },
      ],
    },
  },
  appointment_public_access_tokens: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'public_id',
        'tenant_id',
        'tenant_public_id',
        'appointment_id',
        'appointment_public_id',
        'purpose',
        'generation',
        'token_hash',
        'status',
        'issued_at',
        'expires_at',
        'consumed_at',
        'revoked_at',
        'created_at',
        'updated_at',
        'purge_at',
        'mutation',
      ],
      properties: {
        public_id: { bsonType: 'string', minLength: 1 },
        tenant_id: { bsonType: 'objectId' },
        tenant_public_id: { bsonType: 'string', minLength: 1 },
        appointment_id: { bsonType: 'objectId' },
        appointment_public_id: { bsonType: 'string', minLength: 1 },
        purpose: { enum: ['appointment_manage'] },
        generation: { bsonType: ['int', 'long'], minimum: 1 },
        token_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        status: { enum: ['active', 'consumed', 'revoked', 'expired'] },
        issued_at: { bsonType: 'date' },
        expires_at: { bsonType: 'date' },
        consumed_at: { bsonType: ['date', 'null'] },
        revoked_at: { bsonType: ['date', 'null'] },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
        purge_at: { bsonType: 'date' },
        mutation: {
          bsonType: ['object', 'null'],
          required: [
            'type',
            'idempotency_key_hash',
            'request_fingerprint',
            'result_appointment_version',
            'replacement_token_public_id',
          ],
          properties: {
            type: { enum: ['reschedule', 'cancel'] },
            idempotency_key_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            result_appointment_version: { bsonType: ['int', 'long'], minimum: 1 },
            replacement_token_public_id: { bsonType: ['string', 'null'] },
          },
        },
      },
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
  request_rate_limits: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'scope',
        'tenant_key',
        'subject_hash',
        'bucket_started_at',
        'count',
        'expires_at',
        'created_at',
        'updated_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        scope: { bsonType: 'string', pattern: '^[a-z0-9_.-]{1,64}$' },
        tenant_key: { bsonType: 'string', minLength: 1, maxLength: 128 },
        subject_hash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        bucket_started_at: { bsonType: 'date' },
        count: { bsonType: ['int', 'long'], minimum: 1 },
        expires_at: { bsonType: 'date' },
        created_at: { bsonType: 'date' },
        updated_at: { bsonType: 'date' },
      },
    },
  },
  tenant_provisioning_operations: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'public_id',
        'request_id',
        'operation_type',
        'request_fingerprint',
        'operator_id',
        'reason',
        'tenant_public_id',
        'owner_user_public_id',
        'designation',
        'status',
        'failure_category',
        'created_at',
        'completed_at',
      ],
      properties: {
        _id: { bsonType: 'objectId' },
        public_id: { bsonType: 'string', pattern: UUID_PATTERN },
        request_id: { bsonType: 'string', pattern: UUID_PATTERN },
        operation_type: {
          enum: ['create_tenant', 'set_status', 'deactivate_internal_qa'],
        },
        request_fingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        operator_id: {
          bsonType: 'string',
          minLength: 3,
          maxLength: 120,
          pattern: '^[a-z0-9][a-z0-9._@+-]*$',
        },
        reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
        tenant_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        owner_user_public_id: { bsonType: ['string', 'null'], pattern: UUID_PATTERN },
        designation: { enum: ['customer', 'internal_qa'] },
        status: { enum: ['started', 'completed', 'failed'] },
        failure_category: {
          bsonType: ['string', 'null'],
          maxLength: 80,
          pattern: '^[a-z0-9][a-z0-9_]*$',
        },
        created_at: { bsonType: 'date' },
        completed_at: { bsonType: ['date', 'null'] },
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
          default_slot_cadence_minutes: {
            $ifNull: [
              '$default_slot_cadence_minutes',
              PLATFORM_TENANT_DEFAULTS.defaultSlotCadenceMinutes,
            ],
          },
          locale: { $ifNull: ['$locale', PLATFORM_TENANT_DEFAULTS.locale] },
          currency: { $ifNull: ['$currency', 'USD'] },
          designation: { $ifNull: ['$designation', 'customer'] },
          version: { $ifNull: ['$version', 1] },
          updated_by: { $ifNull: ['$updated_by', null] },
          public_booking_enabled: {
            $ifNull: ['$public_booking_enabled', PLATFORM_TENANT_DEFAULTS.publicBookingEnabled],
          },
          public_profile: {
            $ifNull: [
              '$public_profile',
              {
                business_name: '$display_name',
                description: PLATFORM_TENANT_DEFAULTS.publicProfile.description,
                tagline: PLATFORM_TENANT_DEFAULTS.publicProfile.tagline,
                logo_url: PLATFORM_TENANT_DEFAULTS.publicProfile.logoUrl,
                primary_color: PLATFORM_TENANT_DEFAULTS.publicProfile.primaryColor,
                website_url: PLATFORM_TENANT_DEFAULTS.publicProfile.websiteUrl,
                phone_e164: PLATFORM_TENANT_DEFAULTS.publicProfile.phoneE164,
                email_normalized: PLATFORM_TENANT_DEFAULTS.publicProfile.emailNormalized,
              },
            ],
          },
          booking_policy: {
            $ifNull: [
              '$booking_policy',
              {
                minimum_lead_minutes: PLATFORM_TENANT_DEFAULTS.bookingPolicy.minimumLeadMinutes,
                maximum_advance_days: PLATFORM_TENANT_DEFAULTS.bookingPolicy.maximumAdvanceDays,
              },
            ],
          },
          public_booking_terms: {
            $ifNull: [
              '$public_booking_terms',
              {
                version: PLATFORM_TENANT_DEFAULTS.publicBookingTerms.version,
                acknowledgment_label:
                  PLATFORM_TENANT_DEFAULTS.publicBookingTerms.acknowledgmentLabel,
                terms_url: PLATFORM_TENANT_DEFAULTS.publicBookingTerms.termsUrl,
              },
            ],
          },
          appointment_email_settings: {
            $ifNull: [
              '$appointment_email_settings',
              {
                enabled: PLATFORM_TENANT_DEFAULTS.appointmentEmailSettings.enabled,
                sender_name: '$display_name',
                reply_to_email: PLATFORM_TENANT_DEFAULTS.appointmentEmailSettings.replyToEmail,
              },
            ],
          },
          appointment_self_service: {
            $ifNull: [
              '$appointment_self_service',
              {
                enabled: PLATFORM_TENANT_DEFAULTS.appointmentSelfService.enabled,
                cancellation_cutoff_minutes:
                  PLATFORM_TENANT_DEFAULTS.appointmentSelfService.cancellationCutoffMinutes,
                reschedule_cutoff_minutes:
                  PLATFORM_TENANT_DEFAULTS.appointmentSelfService.rescheduleCutoffMinutes,
              },
            ],
          },
        },
      },
    ]);
  }
  if (existing.has('users')) {
    await db.collection('users').updateMany({}, [
      {
        $set: {
          must_change_password: { $ifNull: ['$must_change_password', false] },
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
          public_self_service_policy: {
            $ifNull: [
              '$public_self_service_policy',
              { cancellation_cutoff_minutes: null, reschedule_cutoff_minutes: null },
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
  if (existing.has('notification_outbox')) {
    await db
      .collection('notification_outbox')
      .updateMany(
        { appointment_access: { $exists: false } },
        { $set: { appointment_access: null } },
      );
    await db
      .collection('notification_outbox')
      .updateMany(
        { public_booking_origin: { $exists: false } },
        { $set: { public_booking_origin: null } },
      );
    const rootDomain =
      db.databaseName === 'booknowtech_staging' ? 'staging.booknowtech.com' : 'booknowtech.com';
    for await (const tenant of db.collection('tenants').find({}, { projection: { slug: 1 } })) {
      if (typeof tenant.slug !== 'string') continue;
      const origin = fallbackBookingOrigin(tenant.slug, rootDomain);
      if (!origin) continue;
      await db
        .collection('notification_outbox')
        .updateMany(
          { tenant_id: tenant._id, public_booking_origin: null },
          { $set: { public_booking_origin: origin } },
        );
    }
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
  if (existing.has('payment_attempts')) {
    await db
      .collection('payment_attempts')
      .updateMany(
        { public_booking_origin: { $exists: false } },
        { $set: { public_booking_origin: null } },
      );
  }
  if (existing.has('tenant_stripe_accounts')) {
    await db.collection('tenant_stripe_accounts').updateMany(
      { readiness_generation: { $exists: false } },
      {
        $set: {
          readiness_generation: 0,
          readiness_refresh_token: null,
          readiness_refresh_started_at: null,
          last_readiness_refresh_attempt_at: null,
          last_readiness_refresh_failure_category: null,
        },
      },
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
  await db.collection('tenant_booking_hostnames').createIndexes([
    {
      key: { public_id: 1 },
      name: 'tenant_booking_hostnames_public_id_unique',
      unique: true,
    },
    {
      key: { environment: 1, normalized_hostname: 1 },
      name: 'tenant_booking_hostnames_environment_hostname_unique',
      unique: true,
    },
    {
      key: { environment: 1, normalized_hostname: 1, status: 1 },
      name: 'tenant_booking_hostnames_active_lookup',
    },
    {
      key: { tenant_id: 1, environment: 1, status: 1, activated_at: 1 },
      name: 'tenant_booking_hostnames_tenant_preferred',
    },
    {
      key: { tenant_id: 1, environment: 1, status: 1 },
      name: 'tenant_booking_hostnames_one_active_per_tenant',
      unique: true,
      partialFilterExpression: { status: 'active' },
    },
  ]);
  await db.collection('tenant_booking_hostname_operations').createIndexes([
    {
      key: { public_id: 1 },
      name: 'tenant_booking_hostname_operations_public_id_unique',
      unique: true,
    },
    {
      key: { request_id: 1 },
      name: 'tenant_booking_hostname_operations_request_id_unique',
      unique: true,
    },
    {
      key: { hostname_public_id: 1, created_at: -1 },
      name: 'tenant_booking_hostname_operations_hostname_created',
    },
    {
      key: { tenant_public_id: 1, environment: 1, created_at: -1 },
      name: 'tenant_booking_hostname_operations_tenant_environment_created',
    },
    {
      key: { status: 1, created_at: 1 },
      name: 'tenant_booking_hostname_operations_status_created',
    },
  ]);
  await db.collection('booknowtech_connect_terms_acceptances').createIndexes([
    { key: { public_id: 1 }, name: 'connect_terms_public_id_unique', unique: true },
    {
      key: { tenant_id: 1, terms_version: 1 },
      name: 'connect_terms_tenant_version_unique',
      unique: true,
    },
    { key: { tenant_id: 1, accepted_at: -1 }, name: 'connect_terms_tenant_accepted' },
  ]);
  await db.collection('tenant_stripe_accounts').createIndexes([
    { key: { public_id: 1 }, name: 'tenant_stripe_accounts_public_id_unique', unique: true },
    {
      key: { stripe_account_id: 1 },
      name: 'tenant_stripe_accounts_stripe_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, public_id: 1 },
      name: 'tenant_stripe_accounts_tenant_public_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, active: 1 },
      name: 'tenant_stripe_accounts_one_active',
      unique: true,
      partialFilterExpression: { active: true },
    },
    { key: { status: 1, last_synced_at: 1 }, name: 'tenant_stripe_accounts_operations' },
    {
      key: { active: 1, last_synced_at: 1, readiness_refresh_started_at: 1 },
      name: 'tenant_stripe_accounts_readiness_refresh',
    },
  ]);
  await db.collection('stripe_connect_operations').createIndexes([
    { key: { public_id: 1 }, name: 'stripe_connect_operations_public_id_unique', unique: true },
    {
      key: { tenant_id: 1, request_id: 1, operation_type: 1 },
      name: 'stripe_connect_operations_request_unique',
      unique: true,
    },
    { key: { status: 1, created_at: 1 }, name: 'stripe_connect_operations_status_created' },
  ]);
  await db.collection('stripe_webhook_events').createIndexes([
    { key: { public_id: 1 }, name: 'stripe_webhook_events_public_id_unique', unique: true },
    { key: { stripe_event_id: 1 }, name: 'stripe_webhook_events_stripe_id_unique', unique: true },
    {
      key: { processing_status: 1, next_attempt_at: 1, received_at: 1 },
      name: 'stripe_webhook_events_worker_poll',
    },
    { key: { tenant_id: 1, received_at: -1 }, name: 'stripe_webhook_events_tenant_received' },
    {
      key: { stripe_account_id: 1, received_at: -1 },
      name: 'stripe_webhook_events_account_received',
    },
  ]);
  await db.collection('stripe_webhook_failure_acknowledgements').createIndexes([
    {
      key: { stripe_webhook_event_id: 1 },
      name: 'stripe_webhook_failure_ack_event_unique',
      unique: true,
    },
    {
      key: { stripe_event_id: 1 },
      name: 'stripe_webhook_failure_ack_stripe_event_unique',
      unique: true,
    },
    { key: { request_id: 1 }, name: 'stripe_webhook_failure_ack_request_unique', unique: true },
    { key: { created_at: -1 }, name: 'stripe_webhook_failure_ack_created' },
  ]);
  await db.collection('tenant_booking_fee_versions').createIndexes([
    { key: { public_id: 1 }, name: 'booking_fee_versions_public_id_unique', unique: true },
    {
      key: { tenant_id: 1, version: 1 },
      name: 'booking_fee_versions_tenant_version_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, idempotency_key_hash: 1 },
      name: 'booking_fee_versions_tenant_idempotency_unique',
      unique: true,
    },
    { key: { tenant_id: 1, created_at: -1 }, name: 'booking_fee_versions_tenant_created' },
  ]);
  await db
    .collection('tenant_payment_execution_settings')
    .createIndex(
      { tenant_id: 1 },
      { name: 'tenant_payment_execution_settings_tenant_unique', unique: true },
    );
  await db.collection('tenant_booking_fee_active').createIndexes([
    { key: { tenant_id: 1 }, name: 'booking_fee_active_tenant_unique', unique: true },
    {
      key: { fee_version_public_id: 1 },
      name: 'booking_fee_active_version_public_unique',
      unique: true,
    },
  ]);
  await db.collection('service_payment_configuration_versions').createIndexes([
    {
      key: { public_id: 1 },
      name: 'service_payment_versions_public_id_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, service_id: 1, version: 1 },
      name: 'service_payment_versions_tenant_service_version_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, service_id: 1, idempotency_key_hash: 1 },
      name: 'service_payment_versions_idempotency_unique',
      unique: true,
    },
  ]);
  await db.collection('service_payment_configuration_active').createIndexes([
    {
      key: { tenant_id: 1, service_id: 1 },
      name: 'service_payment_active_tenant_service_unique',
      unique: true,
    },
    {
      key: { configuration_public_id: 1 },
      name: 'service_payment_active_configuration_public_unique',
      unique: true,
    },
  ]);
  await db.collection('payment_attempts').createIndexes([
    { key: { public_id: 1 }, name: 'payment_attempts_public_id_unique', unique: true },
    {
      key: { recovery_token_hash: 1 },
      name: 'payment_attempts_recovery_token_unique',
      unique: true,
      partialFilterExpression: { recovery_token_hash: { $type: 'string' } },
    },
    {
      key: { tenant_id: 1, idempotency_key_hash: 1 },
      name: 'payment_attempts_tenant_idempotency_unique',
      unique: true,
    },
    {
      key: { stripe_payment_intent_id: 1 },
      name: 'payment_attempts_stripe_intent_unique',
      unique: true,
      partialFilterExpression: { stripe_payment_intent_id: { $type: 'string' } },
    },
    {
      key: { tenant_id: 1, appointment_id: 1, state: 1 },
      name: 'payment_attempts_tenant_appointment_state',
    },
    {
      key: { tenant_id: 1, appointment_id: 1 },
      name: 'payment_attempts_tenant_appointment_unique',
      unique: true,
    },
    {
      key: { state: 1, next_attempt_at: 1, created_at: 1 },
      name: 'payment_attempts_worker_poll',
    },
    {
      key: { state: 1, slot_released: 1, next_attempt_at: 1, claim_started_at: 1 },
      name: 'payment_attempts_reconciliation_poll',
    },
    {
      key: { state: 1, failure_category: 1, updated_at: 1 },
      name: 'payment_attempts_operations_monitor',
    },
  ]);
  await db.collection('provisional_payment_customers').createIndexes([
    { key: { public_id: 1 }, name: 'provisional_payment_customers_public_unique', unique: true },
    {
      key: { tenant_id: 1, customer_input_hash: 1 },
      name: 'provisional_payment_customers_tenant_input',
    },
  ]);
  await db.collection('payment_ledger_entries').createIndexes([
    { key: { public_id: 1 }, name: 'payment_ledger_public_id_unique', unique: true },
    {
      key: { tenant_id: 1, source_identity: 1, source_idempotency_key: 1 },
      name: 'payment_ledger_logical_evidence_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, payment_attempt_id: 1, sequence: 1 },
      name: 'payment_ledger_attempt_sequence_unique',
      unique: true,
    },
    {
      key: { tenant_id: 1, appointment_id: 1, effective_at: 1 },
      name: 'payment_ledger_appointment_history',
    },
  ]);
  await db.collection('payment_reconciliation_requeues').createIndexes([
    { key: { request_id: 1 }, name: 'payment_reconciliation_requeue_request_unique', unique: true },
    {
      key: { payment_attempt_id: 1, created_at: -1 },
      name: 'payment_reconciliation_requeue_attempt_history',
    },
  ]);
  await db.collection('payment_operations_alerts').createIndexes([
    {
      key: { payment_attempt_id: 1, category: 1 },
      name: 'payment_operations_alert_attempt_category_unique',
      unique: true,
    },
    { key: { status: 1, priority: 1, created_at: 1 }, name: 'payment_operations_alert_queue' },
  ]);
  await db.collection('payment_configuration_operations').createIndexes([
    {
      key: { request_id: 1 },
      name: 'payment_configuration_operations_request_unique',
      unique: true,
    },
    {
      key: { tenant_public_id: 1, created_at: -1 },
      name: 'payment_configuration_operations_tenant_created',
    },
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
  await db.collection('tenant_provisioning_operations').createIndexes([
    {
      key: { public_id: 1 },
      name: 'tenant_provisioning_operations_public_id_unique',
      unique: true,
    },
    {
      key: { request_id: 1 },
      name: 'tenant_provisioning_operations_request_id_unique',
      unique: true,
    },
    {
      key: { request_fingerprint: 1 },
      name: 'tenant_provisioning_operations_request_fingerprint',
    },
    {
      key: { tenant_public_id: 1, created_at: -1 },
      name: 'tenant_provisioning_operations_tenant_created',
    },
    {
      key: { status: 1, created_at: 1 },
      name: 'tenant_provisioning_operations_status_created',
    },
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
  await db.collection('appointment_public_access_tokens').createIndexes([
    { key: { public_id: 1 }, name: 'appointment_access_public_id_unique', unique: true },
    { key: { token_hash: 1 }, name: 'appointment_access_token_hash_unique', unique: true },
    {
      key: { tenant_id: 1, appointment_id: 1, purpose: 1, status: 1 },
      name: 'appointment_access_lookup',
    },
    {
      key: { tenant_id: 1, appointment_id: 1, purpose: 1 },
      name: 'appointment_access_one_active',
      unique: true,
      partialFilterExpression: { status: 'active' },
    },
    { key: { purge_at: 1 }, name: 'appointment_access_purge_ttl', expireAfterSeconds: 0 },
  ]);
  await db.collection('notification_outbox').createIndexes([
    { key: { public_id: 1 }, name: 'notification_outbox_public_id_unique', unique: true },
    {
      key: { tenant_id: 1, appointment_id: 1, financial_finalization_key: 1 },
      name: 'notification_outbox_payment_finalization_once',
      unique: true,
      partialFilterExpression: { financial_finalization_key: { $type: 'string' } },
    },
    {
      key: { status: 1, next_attempt_at: 1, created_at: 1 },
      name: 'notification_outbox_worker_poll',
    },
    {
      key: { tenant_id: 1, appointment_id: 1, created_at: -1 },
      name: 'notification_outbox_appointment_history',
    },
    {
      key: { tenant_id: 1, status: 1, processing_started_at: 1 },
      name: 'notification_outbox_tenant_cleanup',
    },
    {
      key: { status: 1, created_at: 1 },
      name: 'notification_outbox_monitor_pending',
    },
    {
      key: { status: 1, processing_started_at: 1 },
      name: 'notification_outbox_monitor_processing',
    },
    {
      key: { status: 1, failed_at: 1 },
      name: 'notification_outbox_monitor_failed',
    },
  ]);
  await db.collection('service_heartbeats').createIndexes([
    {
      key: { service: 1, environment: 1, instance_id: 1 },
      name: 'service_heartbeats_instance_unique',
      unique: true,
    },
    {
      key: { service: 1, environment: 1, observed_at: -1 },
      name: 'service_heartbeats_freshness',
    },
    {
      key: { expires_at: 1 },
      name: 'service_heartbeats_expiry_ttl',
      expireAfterSeconds: 0,
    },
  ]);
  await db.collection('request_rate_limits').createIndexes([
    {
      key: { scope: 1, tenant_key: 1, subject_hash: 1, bucket_started_at: 1 },
      name: 'request_rate_limits_bucket_unique',
      unique: true,
    },
    {
      key: { expires_at: 1 },
      name: 'request_rate_limits_expiry_ttl',
      expireAfterSeconds: 0,
    },
  ]);
}
