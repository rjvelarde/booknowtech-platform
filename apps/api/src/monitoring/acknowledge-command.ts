import { MongoClient } from 'mongodb';
import { authorizeMonitoringAcknowledgement } from './acknowledgement-authorization.js';
import { acknowledgeTerminalWebhookFailure } from './failure-acknowledgement.js';

async function main() {
  const authorization = authorizeMonitoringAcknowledgement();
  const environment = authorization.environment;
  const values = process.argv.slice(2);
  const stripeEventId = values[0] === '--stripe-event-id' ? values[1] : undefined;
  const requestId = values[2] === '--request-id' ? values[3] : undefined;
  if (!stripeEventId || !/^evt_[A-Za-z0-9]+$/u.test(stripeEventId) || !requestId)
    throw new Error('monitoring_acknowledgement_arguments_invalid');
  const client = new MongoClient(environment.MONGODB_URI);
  try {
    await client.connect();
    const result = await acknowledgeTerminalWebhookFailure({
      client,
      database: client.db(environment.MONGODB_DATABASE),
      stripeEventId,
      operatorId: authorization.operatorId,
      reason: authorization.reason,
      requestId,
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
