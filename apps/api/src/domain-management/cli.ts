import { MongoClient } from 'mongodb';
import { authorizeProvisioning } from '../provisioning/guard.js';
import { type DnsTxtResolver, systemDnsTxtResolver } from './dns.js';
import {
  DomainManagementConflict,
  issueChallenge,
  transitionDomain,
  verifyDomain,
} from './service.js';

type Command =
  | 'issue-challenge'
  | 'verify'
  | 'begin-provisioning'
  | 'activate'
  | 'deactivate'
  | 'begin-removal'
  | 'complete-removal';
interface Arguments {
  command: Command;
  requestId: string;
  hostname: string;
  tenantSlug?: string;
  railwayMappingReference?: string;
  operatorAttestedRailwayStatus?: 'ready';
  operatorAttestedTlsStatus?: 'ready';
}

export async function runDomainCli(
  arguments_: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    clientFactory?: (uri: string) => MongoClient;
    resolver?: DnsTxtResolver;
    write?: (value: string) => void;
  } = {},
): Promise<void> {
  const parsed = parseDomainArguments(arguments_);
  const authorization = authorizeProvisioning(environment);
  const client = (dependencies.clientFactory ?? ((uri) => new MongoClient(uri)))(
    authorization.environment.MONGODB_URI,
  );
  const write = dependencies.write ?? ((value: string) => process.stdout.write(`${value}\n`));
  try {
    await client.connect();
    const common = {
      client,
      database: client.db(authorization.environment.MONGODB_DATABASE),
      authorization,
      requestId: parsed.requestId,
      hostname: parsed.hostname,
    };
    const result =
      parsed.command === 'issue-challenge'
        ? await issueChallenge({ ...common, tenantSlug: parsed.tenantSlug! })
        : parsed.command === 'verify'
          ? await verifyDomain({
              ...common,
              resolver: dependencies.resolver ?? systemDnsTxtResolver,
            })
          : await transitionDomain({
              ...common,
              operation: parsed.command.replaceAll('-', '_') as
                | 'begin_provisioning'
                | 'activate'
                | 'deactivate'
                | 'begin_removal'
                | 'complete_removal',
              ...(parsed.railwayMappingReference
                ? { railwayMappingReference: parsed.railwayMappingReference }
                : {}),
              ...(parsed.operatorAttestedRailwayStatus
                ? { railwayStatus: parsed.operatorAttestedRailwayStatus }
                : {}),
              ...(parsed.operatorAttestedTlsStatus
                ? { tlsStatus: parsed.operatorAttestedTlsStatus }
                : {}),
            });
    const output = result.challenge_token
      ? { ...result, txt_record_value: `booknowtech-verification=${result.challenge_token}` }
      : result;
    write(JSON.stringify(output));
  } finally {
    await client.close();
  }
}

export function parseDomainArguments(arguments_: string[]): Arguments {
  if (arguments_[0] === '--') arguments_ = arguments_.slice(1);
  const command = arguments_[0] as Command;
  const commands: Command[] = [
    'issue-challenge',
    'verify',
    'begin-provisioning',
    'activate',
    'deactivate',
    'begin-removal',
    'complete-removal',
  ];
  if (!commands.includes(command)) throw new Error('Invalid domain command');
  const values = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith('--') || !value || values.has(flag))
      throw new Error('Invalid domain arguments');
    values.set(flag, value);
  }
  const allowed = new Set([
    '--request-id',
    '--hostname',
    '--tenant',
    '--operator-attested-railway-mapping-reference',
    '--operator-attested-railway-status',
    '--operator-attested-tls-status',
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key)))
    throw new Error('Invalid domain arguments');
  const requestId = values.get('--request-id');
  const hostname = values.get('--hostname');
  if (
    !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestId) ||
    !hostname
  )
    throw new Error('Invalid domain arguments');
  const tenantSlug = values.get('--tenant');
  const railwayMappingReference = values.get('--operator-attested-railway-mapping-reference');
  const railwayStatus = values.get('--operator-attested-railway-status');
  const tlsStatus = values.get('--operator-attested-tls-status');
  if (
    command === 'issue-challenge' &&
    (!tenantSlug || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(tenantSlug))
  )
    throw new Error('Invalid domain arguments');
  if (command !== 'issue-challenge' && tenantSlug) throw new Error('Invalid domain arguments');
  if (
    command === 'begin-provisioning'
      ? !validRailwayReference(railwayMappingReference)
      : Boolean(railwayMappingReference)
  )
    throw new Error('Invalid domain arguments');
  if (command === 'activate') {
    if (railwayStatus !== 'ready' || tlsStatus !== 'ready')
      throw new Error(
        'Activation requires manually checked, operator-attested Railway and TLS readiness',
      );
  } else if (railwayStatus || tlsStatus) throw new Error('Invalid domain arguments');
  return {
    command,
    requestId,
    hostname,
    ...(tenantSlug ? { tenantSlug } : {}),
    ...(railwayMappingReference ? { railwayMappingReference } : {}),
    ...(railwayStatus === 'ready' ? { operatorAttestedRailwayStatus: railwayStatus } : {}),
    ...(tlsStatus === 'ready' ? { operatorAttestedTlsStatus: tlsStatus } : {}),
  };
}

function validRailwayReference(value: string | undefined): boolean {
  return Boolean(
    value &&
    value === value.trim() &&
    value.length <= 200 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }),
  );
}

export function safeDomainError(error: unknown): { code: string; message: string } {
  if (error instanceof DomainManagementConflict)
    return { code: error.code, message: 'The booking hostname operation could not be completed.' };
  return {
    code: 'booking_hostname_operation_failed',
    message: 'The booking hostname operation could not be completed.',
  };
}
