import { buildApplication } from './app.js';
import { loadEnvironment } from './config.js';
import { AtlasReadinessProbe } from './readiness.js';
import { MongoRateLimiter } from './rate-limit/limiter.js';

async function start(): Promise<void> {
  const environment = loadEnvironment();
  const readiness = new AtlasReadinessProbe(environment.MONGODB_URI);
  const adminClient = environment.TENANT_ADMIN_ENABLED
    ? new MongoClient(environment.MONGODB_URI)
    : undefined;
  if (adminClient) await adminClient.connect();
  const app = adminClient
    ? await buildApplication({
        environment,
        readiness,
        adminStore: new AdminStore(adminClient.db(environment.MONGODB_DATABASE)),
        rateLimiter: new MongoRateLimiter(
          adminClient.db(environment.MONGODB_DATABASE),
          environment.RATE_LIMIT_KEY_SECRET,
        ),
        closeAdmin: async () => adminClient.close(),
      })
    : await buildApplication({ environment, readiness });

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
import { MongoClient } from 'mongodb';

import { AdminStore } from './admin/store.js';
