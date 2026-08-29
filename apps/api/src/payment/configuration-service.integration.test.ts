import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateBookingFee,
  activateServiceConfiguration,
  setTenantPaymentExecution,
} from './configuration-service.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('production payment configuration operator controls', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_payment_config_${randomUUID().replaceAll('-', '')}`);
  const tenantId = new ObjectId();
  const tenantPublicId = randomUUID();
  const serviceId = new ObjectId();
  const servicePublicId = randomUUID();
  const common = {
    database: db,
    environment: 'staging' as const,
    operatorId: 'approved.operator',
    reason: 'Approved configuration for the named staging design partner.',
    tenantSlug: 'design-partner',
  };

  beforeAll(async () => {
    await client.connect();
    await db
      .collection('payment_configuration_operations')
      .createIndex({ request_id: 1 }, { unique: true });
    await db
      .collection('tenant_booking_fee_versions')
      .createIndex({ tenant_id: 1, version: 1 }, { unique: true });
    await db
      .collection('tenant_booking_fee_active')
      .createIndex({ tenant_id: 1 }, { unique: true });
    await db
      .collection('service_payment_configuration_versions')
      .createIndex({ tenant_id: 1, service_id: 1, version: 1 }, { unique: true });
    await db
      .collection('service_payment_configuration_active')
      .createIndex({ tenant_id: 1, service_id: 1 }, { unique: true });
    await db
      .collection('tenant_payment_execution_settings')
      .createIndex({ tenant_id: 1 }, { unique: true });
    await db.collection('tenants').insertOne({
      _id: tenantId,
      public_id: tenantPublicId,
      slug: 'design-partner',
      status: 'active',
      currency: 'USD',
    });
    await db.collection('services').insertOne({
      _id: serviceId,
      public_id: servicePublicId,
      tenant_id: tenantId,
      base_price_minor: 5500,
      currency: 'USD',
    });
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('creates one immutable fee version with exact replay and changed-input conflict', async () => {
    const requestId = randomUUID();
    const input = { ...common, requestId, amountMinor: 125 };
    expect(await activateBookingFee(input)).toMatchObject({
      outcome: 'completed',
      version: 1,
      amount_minor: 125,
    });
    expect(await activateBookingFee(input)).toMatchObject({ outcome: 'replayed', version: 1 });
    await expect(activateBookingFee({ ...input, amountMinor: 150 })).rejects.toThrow(
      'payment_configuration_request_conflict',
    );
    expect(
      await db.collection('tenant_booking_fee_versions').countDocuments({ tenant_id: tenantId }),
    ).toBe(1);
    expect(await db.collection('audit_logs').countDocuments({ request_id: requestId })).toBe(1);
  });

  it('preserves deposit normalization and immutable service versions', async () => {
    const fixed = await activateServiceConfiguration({
      ...common,
      requestId: randomUUID(),
      servicePublicId,
      paymentMode: 'fixed_deposit',
      fixedDepositMinor: 2500,
    });
    expect(fixed).toMatchObject({ payment_mode: 'fixed_deposit', amount_minor: 2500, version: 1 });
    const full = await activateServiceConfiguration({
      ...common,
      requestId: randomUUID(),
      servicePublicId,
      paymentMode: 'fixed_deposit',
      fixedDepositMinor: 5500,
    });
    expect(full).toMatchObject({ payment_mode: 'full', amount_minor: null, version: 2 });
    await expect(
      activateServiceConfiguration({
        ...common,
        requestId: randomUUID(),
        servicePublicId,
        paymentMode: 'fixed_deposit',
        fixedDepositMinor: 5501,
      }),
    ).rejects.toThrow('deposit_exceeds_service_price');
    expect(
      await db
        .collection('service_payment_configuration_versions')
        .countDocuments({ tenant_id: tenantId, service_id: serviceId }),
    ).toBe(2);
  });

  it('audits enable-disable-enable without touching environment authority', async () => {
    for (const enabled of [true, false, true]) {
      expect(
        await setTenantPaymentExecution({ ...common, requestId: randomUUID(), enabled }),
      ).toMatchObject({ enabled });
    }
    expect(
      await db.collection('tenant_payment_execution_settings').findOne({ tenant_id: tenantId }),
    ).toMatchObject({ enabled: true });
    expect(
      await db
        .collection('payment_configuration_operations')
        .countDocuments({ operation_type: 'set_tenant_execution' }),
    ).toBe(3);
  });

  it('converges concurrent exact requests on one mutation and audit event', async () => {
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        activateBookingFee({ ...common, requestId, amountMinor: 175 }),
      ),
    );
    expect(results.filter(({ outcome }) => outcome === 'completed')).toHaveLength(1);
    expect(
      await db.collection('tenant_booking_fee_versions').countDocuments({ request_id: requestId }),
    ).toBe(1);
    expect(await db.collection('audit_logs').countDocuments({ request_id: requestId })).toBe(1);
  });
});
