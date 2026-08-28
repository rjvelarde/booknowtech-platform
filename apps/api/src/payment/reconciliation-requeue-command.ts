import { MongoClient } from 'mongodb';
import { authorizePaymentReconciliationRequeue } from './reconciliation-requeue-authorization.js';
import { requeuePaymentReconciliation } from './reconciliation-requeue.js';

async function main() {
  const authorization = authorizePaymentReconciliationRequeue();
  const values = process.argv.slice(2);
  const attemptPublicId = values[0] === '--attempt-public-id' ? values[1] : undefined;
  const requestId = values[2] === '--request-id' ? values[3] : undefined;
  if (!attemptPublicId || !requestId)
    throw new Error('payment_reconciliation_requeue_arguments_invalid');
  const client = new MongoClient(authorization.environment.MONGODB_URI);
  try {
    await client.connect();
    const result = await requeuePaymentReconciliation({
      client,
      database: client.db(authorization.environment.MONGODB_DATABASE),
      attemptPublicId,
      operatorId: authorization.operatorId,
      reason: authorization.reason,
      requestId,
      environment: authorization.environment.ENVIRONMENT_ID as 'staging' | 'production',
    });
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
