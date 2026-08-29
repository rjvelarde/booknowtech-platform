import { MongoClient } from 'mongodb';
import { authorizePaymentConfiguration } from './configuration-authorization.js';
import { parsePaymentConfigurationArguments } from './configuration-cli.js';
import {
  activateBookingFee,
  activateServiceConfiguration,
  setTenantPaymentExecution,
} from './configuration-service.js';

async function main() {
  const authorization = authorizePaymentConfiguration();
  const parsed = parsePaymentConfigurationArguments(process.argv.slice(2));
  const client = new MongoClient(authorization.environment.MONGODB_URI);
  try {
    await client.connect();
    const common = {
      database: client.db(authorization.environment.MONGODB_DATABASE),
      environment: authorization.environment.ENVIRONMENT_ID as 'staging' | 'production',
      operatorId: authorization.operatorId,
      reason: authorization.reason,
      requestId: parsed.requestId,
      tenantSlug: parsed.tenantSlug,
    };
    const result =
      parsed.command === 'set-booking-fee'
        ? await activateBookingFee({ ...common, amountMinor: parsed.amountMinor! })
        : parsed.command === 'set-service-config'
          ? await activateServiceConfiguration({
              ...common,
              servicePublicId: parsed.servicePublicId!,
              paymentMode: parsed.paymentMode!,
              ...(parsed.fixedDepositMinor === undefined
                ? {}
                : { fixedDepositMinor: parsed.fixedDepositMinor }),
            })
          : await setTenantPaymentExecution({ ...common, enabled: parsed.enabled! });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' })}\n`,
  );
  process.exitCode = 1;
});
