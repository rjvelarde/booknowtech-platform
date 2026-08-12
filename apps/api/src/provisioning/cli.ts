import { stdin, stdout } from 'node:process';
import { MongoClient } from 'mongodb';
import { hashPassword } from '../auth/password.js';
import { authorizeProvisioning } from './guard.js';
import { readAndValidateProvisioningInput } from './input.js';
import {
  ProvisioningConflict,
  ProvisioningPersistenceFailure,
  provisionTenant,
} from './service.js';

export class ProvisioningTemporaryPasswordFailure extends Error {
  public constructor() {
    super('Temporary password collection failed');
  }
}

export class ProvisioningConnectionFailure extends Error {
  public constructor() {
    super('Provisioning database connection failed');
  }
}

export class ProvisioningArgumentsFailure extends Error {
  public constructor() {
    super('Provisioning arguments failed validation');
  }
}

export class ProvisioningAuthorizationFailure extends Error {
  public constructor() {
    super('Provisioning authorization failed');
  }
}

export class ProvisioningInputFailure extends Error {
  public constructor() {
    super('Provisioning input failed validation');
  }
}

interface CommandArguments {
  requestId: string;
  inputPath: string;
  dryValidate: boolean;
}

export async function runProvisioningCli(
  arguments_: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    clientFactory?: (uri: string) => MongoClient;
    passwordReader?: () => Promise<string>;
    write?: (value: string) => void;
  } = {},
): Promise<void> {
  let parsed: CommandArguments;
  try {
    parsed = parseArguments(arguments_);
  } catch {
    throw new ProvisioningArgumentsFailure();
  }
  let authorization: ReturnType<typeof authorizeProvisioning>;
  try {
    authorization = authorizeProvisioning(environment);
  } catch {
    throw new ProvisioningAuthorizationFailure();
  }
  let input: Awaited<ReturnType<typeof readAndValidateProvisioningInput>>;
  try {
    input = await readAndValidateProvisioningInput(
      parsed.inputPath,
      authorization.environment.BOOKING_ROOT_DOMAIN,
    );
  } catch {
    throw new ProvisioningInputFailure();
  }
  const write = dependencies.write ?? ((value) => stdout.write(`${value}\n`));

  if (parsed.dryValidate) {
    write(
      JSON.stringify({
        outcome: 'validated',
        request_id: parsed.requestId,
        slug: input.slug,
        fallback_hostname: input.fallback_hostname,
        environment: authorization.environment.ENVIRONMENT_ID,
      }),
    );
    return;
  }

  const readPassword = dependencies.passwordReader ?? readConfirmedMaskedPassword;
  let passwordHash: string;
  try {
    passwordHash = await hashTemporaryPassword(await readPassword());
  } catch {
    throw new ProvisioningTemporaryPasswordFailure();
  }

  const client = (dependencies.clientFactory ?? ((uri) => new MongoClient(uri)))(
    authorization.environment.MONGODB_URI,
  );
  try {
    try {
      await client.connect();
    } catch {
      throw new ProvisioningConnectionFailure();
    }
    const result = await provisionTenant({
      client,
      database: client.db(authorization.environment.MONGODB_DATABASE),
      authorization,
      requestId: parsed.requestId,
      provisioningInput: input,
      passwordHash,
    });
    write(JSON.stringify(result));
  } finally {
    await client.close();
  }
}

export function parseArguments(arguments_: string[]): CommandArguments {
  // pnpm forwards an optional separator to the script when invoking this command.
  if (arguments_[0] === '--') arguments_ = arguments_.slice(1);
  if (arguments_[0] !== 'create') throw new Error('Usage: tenant-provision create');
  let requestId: string | undefined;
  let inputPath: string | undefined;
  let dryValidate = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--request-id') requestId = arguments_[++index];
    else if (argument === '--input') inputPath = arguments_[++index];
    else if (argument === '--dry-validate') dryValidate = true;
    else throw new Error('Invalid provisioning arguments');
  }
  if (!requestId || !isUuid(requestId) || !inputPath)
    throw new Error('Invalid provisioning arguments');
  return { requestId, inputPath, dryValidate };
}

async function readConfirmedMaskedPassword(): Promise<string> {
  const first = await readMaskedLine('Temporary password: ');
  const second = await readMaskedLine('Confirm temporary password: ');
  if (first !== second) throw new Error('Temporary passwords do not match');
  return first;
}

function readMaskedLine(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Masked TTY input is required');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Provisioning cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

function validateTemporaryPassword(value: string): void {
  if (value.length < 16 || value.length > 256)
    throw new Error('Temporary password does not meet requirements');
}

export async function hashTemporaryPassword(value: string): Promise<string> {
  validateTemporaryPassword(value);
  return hashPassword(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function safeProvisioningError(error: unknown): { code: string; message: string } {
  if (error instanceof ProvisioningConflict)
    return { code: error.code, message: 'The provisioning request could not be completed.' };
  if (error instanceof ProvisioningTemporaryPasswordFailure)
    return {
      code: 'temporary_password_rejected',
      message: 'The provisioning request could not be completed.',
    };
  if (error instanceof ProvisioningConnectionFailure)
    return {
      code: 'provisioning_database_connection_failed',
      message: 'The provisioning request could not be completed.',
    };
  if (error instanceof ProvisioningArgumentsFailure)
    return {
      code: 'provisioning_arguments_invalid',
      message: 'The provisioning request could not be completed.',
    };
  if (error instanceof ProvisioningAuthorizationFailure)
    return {
      code: 'provisioning_authorization_denied',
      message: 'The provisioning request could not be completed.',
    };
  if (error instanceof ProvisioningInputFailure)
    return {
      code: 'provisioning_input_invalid',
      message: 'The provisioning request could not be completed.',
    };
  if (error instanceof ProvisioningPersistenceFailure)
    return {
      code: `provisioning_${error.stage}_failed`,
      message: 'The provisioning request could not be completed.',
    };
  return {
    code: 'provisioning_failed',
    message: 'The provisioning request could not be completed.',
  };
}
