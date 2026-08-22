import { stderr } from 'node:process';
import { runDomainCli, safeDomainError } from './cli.js';

try {
  await runDomainCli();
} catch (error) {
  stderr.write(`${JSON.stringify({ error: safeDomainError(error) })}\n`);
  process.exitCode = 1;
}
