import { loadWorkerEnvironment } from './config.js';
import { verifyPostmarkIdentity } from './postmark-readiness.js';

void verifyPostmarkIdentity(loadWorkerEnvironment())
  .then(() => process.stdout.write('Postmark deployment readiness passed\n'))
  .catch((error: unknown) => {
    process.stderr.write(
      `Postmark deployment readiness failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
