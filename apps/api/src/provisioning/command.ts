import { stderr } from 'node:process';
import { runProvisioningCli, safeProvisioningError } from './cli.js';

try {
  await runProvisioningCli();
} catch (error) {
  stderr.write(`${JSON.stringify({ error: safeProvisioningError(error) })}\n`);
  process.exitCode = 1;
}
