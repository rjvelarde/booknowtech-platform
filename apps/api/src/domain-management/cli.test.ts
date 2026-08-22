import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDomainArguments } from './cli.js';

describe('booking domain CLI arguments', () => {
  it('requires explicit operator-attested readiness for activation', () => {
    const requestId = randomUUID();
    expect(
      parseDomainArguments([
        'activate',
        '--hostname',
        'booking.example.com',
        '--request-id',
        requestId,
        '--operator-attested-railway-status',
        'ready',
        '--operator-attested-tls-status',
        'ready',
      ]),
    ).toMatchObject({
      command: 'activate',
      operatorAttestedRailwayStatus: 'ready',
      operatorAttestedTlsStatus: 'ready',
    });
    expect(() =>
      parseDomainArguments([
        'activate',
        '--hostname',
        'booking.example.com',
        '--request-id',
        requestId,
      ]),
    ).toThrow(/manually checked/u);
  });
  it('rejects uppercase UUIDs without changing provisioning UUID behavior', () => {
    expect(() =>
      parseDomainArguments([
        'verify',
        '--hostname',
        'booking.example.com',
        '--request-id',
        randomUUID().toUpperCase(),
      ]),
    ).toThrow();
  });
  it('scopes tenant and Railway reference arguments to their commands', () => {
    const requestId = randomUUID();
    expect(
      parseDomainArguments([
        'issue-challenge',
        '--hostname',
        'booking.example.com',
        '--tenant',
        'customer',
        '--request-id',
        requestId,
      ]),
    ).toMatchObject({ tenantSlug: 'customer' });
    expect(
      parseDomainArguments([
        'begin-provisioning',
        '--hostname',
        'booking.example.com',
        '--operator-attested-railway-mapping-reference',
        'railway-domain-123',
        '--request-id',
        requestId,
      ]),
    ).toMatchObject({ railwayMappingReference: 'railway-domain-123' });
    expect(() =>
      parseDomainArguments([
        'begin-provisioning',
        '--hostname',
        'booking.example.com',
        '--operator-attested-railway-mapping-reference',
        ' railway-domain-123',
        '--request-id',
        requestId,
      ]),
    ).toThrow();
  });
});
