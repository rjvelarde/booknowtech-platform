import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import {
  ProvisioningArgumentsFailure,
  ProvisioningAuthorizationFailure,
  ProvisioningConnectionFailure,
  ProvisioningInputFailure,
  ProvisioningTemporaryPasswordFailure,
  hashTemporaryPassword,
  parseArguments,
  runProvisioningCli,
  safeProvisioningError,
} from './cli.js';
import { ProvisioningPersistenceFailure } from './service.js';

const directories: string[] = [];
const environment = {
  NODE_ENV: 'staging',
  ENVIRONMENT_ID: 'staging',
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
  HOST: '127.0.0.1',
  PORT: '8080',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://secret-user:secret-password@localhost:27017',
  MONGODB_DATABASE: 'booknowtech_staging',
  BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
  ADMIN_ORIGIN: 'https://admin.staging.booknowtech.com',
  TENANT_ADMIN_ENABLED: 'true',
  OPENAPI_ENABLED: 'true',
  PUBLIC_APPOINTMENT_TOKEN_SECRET: 'a-safe-public-appointment-secret-value',
  RATE_LIMIT_KEY_SECRET: 'a-different-safe-rate-limit-secret-value',
  MONITORING_TOKEN: 'bnt_monitoring_staging_0123456789abcdef0123456789abcdef',
  PROVISIONING_OPERATOR_ID: 'operator@example.test',
  PROVISIONING_REASON: 'Provision an approved internal design partner.',
  PROVISIONING_APPROVED: 'true',
};

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
);

describe('tenant-provision CLI', () => {
  it('accepts the bounded commands and never accepts a password argument', () => {
    const id = randomUUID();
    expect(parseArguments(['create', '--request-id', id, '--input', 'tenant.json'])).toMatchObject({
      requestId: id,
    });
    expect(
      parseArguments(['--', 'create', '--request-id', id, '--input', 'tenant.json']),
    ).toMatchObject({ requestId: id });
    expect(
      parseArguments([
        'set-status',
        '--request-id',
        id,
        '--tenant',
        'internal-qa',
        '--status',
        'suspended',
      ]),
    ).toMatchObject({ command: 'set-status', tenantSlug: 'internal-qa', status: 'suspended' });
    expect(
      parseArguments(['deactivate-internal-qa', '--request-id', id, '--tenant', 'internal-qa']),
    ).toMatchObject({ command: 'deactivate-internal-qa', tenantSlug: 'internal-qa' });
    expect(
      parseArguments([
        'reset-owner-password',
        '--request-id',
        id,
        '--tenant-id',
        randomUUID(),
        '--owner-email',
        ' Owner@Example.Test ',
        '--dry-validate',
      ]),
    ).toMatchObject({
      command: 'reset-owner-password',
      ownerEmail: 'owner@example.test',
      dryValidate: true,
    });
    expect(() =>
      parseArguments([
        'create',
        '--request-id',
        id,
        '--input',
        'tenant.json',
        '--password',
        'secret',
      ]),
    ).toThrow();
    expect(() =>
      parseArguments([
        'set-status',
        '--request-id',
        id,
        '--tenant',
        'internal-qa',
        '--status',
        'deleted',
      ]),
    ).toThrow();
  });

  it('requires exactly one tenant selector and one owner selector for password reset', () => {
    const id = randomUUID();
    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const base = ['reset-owner-password', '--request-id', id];
    expect(() => parseArguments([...base, '--tenant-id', tenantId])).toThrow();
    expect(() =>
      parseArguments([
        ...base,
        '--tenant-id',
        tenantId,
        '--owner-id',
        ownerId,
        '--owner-email',
        'owner@example.test',
      ]),
    ).toThrow();
    expect(() =>
      parseArguments([
        ...base,
        '--tenant-id',
        tenantId,
        '--tenant',
        'tenant',
        '--owner-id',
        ownerId,
      ]),
    ).toThrow();
    expect(() =>
      parseArguments([...base, '--tenant-id', 'not-a-uuid', '--owner-id', ownerId]),
    ).toThrow();
    expect(() =>
      parseArguments([...base, '--tenant', 'tenant', '--owner-email', 'not-an-email']),
    ).toThrow();
    expect(() =>
      parseArguments([
        ...base,
        '--tenant',
        'tenant',
        '--owner-email',
        'owner@example.test',
        '--password',
        'Never1InArgs',
      ]),
    ).toThrow();
  });

  it('dry-validates input without reading a password or constructing a Mongo client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booknowtech-provisioning-'));
    directories.push(directory);
    const inputPath = join(directory, 'tenant.json');
    await writeFile(inputPath, JSON.stringify(validInput()));
    const clientFactory = vi.fn();
    const passwordReader = vi.fn();
    const output: string[] = [];
    await runProvisioningCli(
      ['create', '--request-id', randomUUID(), '--input', inputPath, '--dry-validate'],
      environment,
      { clientFactory, passwordReader, write: (value) => output.push(value) },
    );
    expect(clientFactory).not.toHaveBeenCalled();
    expect(passwordReader).not.toHaveBeenCalled();
    expect(output.join('')).toContain('validated');
    expect(output.join('')).not.toContain('owner@example.test');
  });

  it('rejects password-bearing input files and redacts unexpected errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booknowtech-provisioning-'));
    directories.push(directory);
    const inputPath = join(directory, 'tenant.json');
    await writeFile(inputPath, JSON.stringify({ ...validInput(), password: 'must-never-be-read' }));
    await expect(
      runProvisioningCli(
        ['create', '--request-id', randomUUID(), '--input', inputPath, '--dry-validate'],
        environment,
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(safeProvisioningError(new Error('secret-password')))).not.toContain(
      'secret-password',
    );
  });

  it('immediately converts the temporary password to the existing scrypt format', async () => {
    const plaintext = 'Temporary-Password-Only-In-Memory-1';
    const encoded = await hashTemporaryPassword(plaintext);
    expect(encoded).toMatch(/^scrypt\$/u);
    expect(encoded).not.toContain(plaintext);
    await expect(verifyPassword(plaintext, encoded)).resolves.toBe(true);
  });

  it('enforces replacement-password complexity before hashing a temporary password', async () => {
    await expect(hashTemporaryPassword('all-lowercase-password')).rejects.toThrow();
    await expect(hashTemporaryPassword('NO-LOWERCASE-PASSWORD-1')).rejects.toThrow();
    await expect(hashTemporaryPassword('NoNumberInThisPassword')).rejects.toThrow();
  });

  it('reports only safe provisioning failure categories', () => {
    expect(safeProvisioningError(new ProvisioningTemporaryPasswordFailure()).code).toBe(
      'temporary_password_rejected',
    );
    expect(safeProvisioningError(new ProvisioningConnectionFailure()).code).toBe(
      'provisioning_database_connection_failed',
    );
    expect(safeProvisioningError(new ProvisioningArgumentsFailure()).code).toBe(
      'provisioning_arguments_invalid',
    );
    expect(safeProvisioningError(new ProvisioningAuthorizationFailure()).code).toBe(
      'provisioning_authorization_denied',
    );
    expect(safeProvisioningError(new ProvisioningInputFailure()).code).toBe(
      'provisioning_input_invalid',
    );
    expect(safeProvisioningError(new ProvisioningPersistenceFailure('tenant_insert')).code).toBe(
      'provisioning_tenant_insert_failed',
    );
  });

  it('rejects an unauthorized reset before connecting or collecting a password', async () => {
    const clientFactory = vi.fn();
    const passwordReader = vi.fn();
    await expect(
      runProvisioningCli(
        [
          'reset-owner-password',
          '--request-id',
          randomUUID(),
          '--tenant',
          'password-reset-tenant',
          '--owner-email',
          'owner@example.test',
          '--dry-validate',
        ],
        { ...environment, PROVISIONING_APPROVED: 'false' },
        { clientFactory, passwordReader },
      ),
    ).rejects.toBeInstanceOf(ProvisioningAuthorizationFailure);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(passwordReader).not.toHaveBeenCalled();
  });
});

function validInput() {
  return {
    business_name: 'Internal QA',
    slug: 'internal-qa',
    timezone: 'America/New_York',
    currency: 'USD',
    designation: 'internal_qa',
    owner: { display_name: 'QA Owner', email: 'owner@example.test' },
  };
}
