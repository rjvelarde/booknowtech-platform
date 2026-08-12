import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import {
  hashTemporaryPassword,
  parseArguments,
  runProvisioningCli,
  safeProvisioningError,
} from './cli.js';

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
  PROVISIONING_OPERATOR_ID: 'operator@example.test',
  PROVISIONING_REASON: 'Provision an approved internal design partner.',
  PROVISIONING_APPROVED: 'true',
};

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
);

describe('tenant-provision CLI', () => {
  it('accepts only the create command and never accepts a password argument', () => {
    const id = randomUUID();
    expect(parseArguments(['create', '--request-id', id, '--input', 'tenant.json'])).toMatchObject({
      requestId: id,
    });
    expect(
      parseArguments(['--', 'create', '--request-id', id, '--input', 'tenant.json']),
    ).toMatchObject({ requestId: id });
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
    const plaintext = 'Temporary-Password-Only-In-Memory';
    const encoded = await hashTemporaryPassword(plaintext);
    expect(encoded).toMatch(/^scrypt\$/u);
    expect(encoded).not.toContain(plaintext);
    await expect(verifyPassword(plaintext, encoded)).resolves.toBe(true);
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
