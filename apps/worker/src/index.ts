import pino from 'pino';

import { loadWorkerEnvironment } from './config.js';
import { createWorkerLifecycle } from './lifecycle.js';

async function start(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const logger = pino({
    level: environment.LOG_LEVEL,
    base: {
      service: 'booknowtech-worker',
      environment: environment.NODE_ENV,
      version: environment.BUILD_VERSION,
    },
    redact: {
      paths: ['*.authorization', '*.cookie', '*.credential', '*.password', '*.secret', '*.token'],
      censor: '[REDACTED]',
    },
  });
  const lifecycle = createWorkerLifecycle(logger);

  logger.info({ event: 'service.started' });
  const signal = await lifecycle.waitForShutdown();
  logger.info({ event: 'service.stopping', signal });
  lifecycle.dispose();
  logger.info({ event: 'service.stopped' });
}

void start().catch((error: unknown) => {
  process.stderr.write(
    `Worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
