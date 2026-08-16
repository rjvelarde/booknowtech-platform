import { MongoClient } from 'mongodb';

import { AdminStore } from './admin/store.js';
import { buildApplication } from './app.js';
import { loadEnvironment } from './config.js';
import { AtlasReadinessProbe } from './readiness.js';
import { MongoRateLimiter } from './rate-limit/limiter.js';
import { MongoMonitoringReader } from './monitoring/store.js';

async function start(): Promise<void> {
  const environment = loadEnvironment();
  const readiness = new AtlasReadinessProbe(environment.MONGODB_URI);
  const applicationClient = new MongoClient(environment.MONGODB_URI);
  await applicationClient.connect();
  const database = applicationClient.db(environment.MONGODB_DATABASE);
  const app = await buildApplication({
    environment,
    readiness,
    monitoringReader: new MongoMonitoringReader(database),
    closeAdmin: async () => applicationClient.close(),
    ...(environment.TENANT_ADMIN_ENABLED
      ? {
          adminStore: new AdminStore(database),
          rateLimiter: new MongoRateLimiter(database, environment.RATE_LIMIT_KEY_SECRET),
        }
      : {}),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ event: 'service.stopping', signal });
    await app.close();
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error, event: 'process.uncaught_exception' });
    void app.close().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason, event: 'process.unhandled_rejection' });
    void app.close().finally(() => process.exit(1));
  });

  await app.listen({ host: environment.HOST, port: environment.PORT });
  app.log.info({ event: 'service.started' });
}

void start().catch((error: unknown) => {
  process.stderr.write(
    `API startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
