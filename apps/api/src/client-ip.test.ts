import { describe, expect, it } from 'vitest';

import type { FastifyRequest } from 'fastify';

import { clientIp, isTrustedProxyAddress, normalizeIpAddress } from './client-ip.js';
import type { Environment } from './config.js';
import { testEnvironment } from './test-fixtures.js';

describe('canonical client IP', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.23.4.5', true],
    ['172.31.255.254', true],
    ['192.168.10.4', true],
    ['169.254.4.2', true],
    ['100.64.0.5', true],
    ['100.127.255.254', true],
    ['100.128.0.1', false],
    ['::1', true],
    ['fd12:3456:789a::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['2606:4700:4700::1111', false],
    ['not-an-ip', false],
  ])('classifies trusted proxy peer %s', (address, trusted) => {
    expect(isTrustedProxyAddress(address)).toBe(trusted);
  });

  it.each([
    ['203.0.113.8', '203.0.113.8'],
    ['2001:db8::5', '2001:db8::5'],
    ['2001:0DB8:0:0::5', '2001:db8::5'],
    ['::ffff:192.0.2.9', '192.0.2.9'],
    [' 203.0.113.8', null],
    ['203.0.113.8, 198.51.100.2', null],
    ['unknown', null],
  ])('normalizes one IP address %s', (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it.each(['staging', 'production'] as const)(
    'accepts the canonical header from a Railway private-network peer in %s',
    (nodeEnvironment) => {
      expect(
        clientIp(
          request('fd12:3456:789a::10', {
            'x-booknowtech-client-ip': '2001:db8::25',
            'x-forwarded-for': '198.51.100.99',
            'x-real-ip': '198.51.100.98',
          }),
          environment(nodeEnvironment),
        ),
      ).toBe('2001:db8::25');
    },
  );

  it('accepts the canonical header from the Railway shared-address peer observed in staging', () => {
    expect(
      clientIp(
        request('100.64.0.5', { 'x-booknowtech-client-ip': '203.0.113.25' }),
        environment('staging'),
      ),
    ).toBe('203.0.113.25');
  });

  it('ignores spoofed forwarding headers on direct API access', () => {
    expect(
      clientIp(
        request('198.51.100.40', {
          'x-booknowtech-client-ip': '203.0.113.1',
          'x-forwarded-for': '203.0.113.2',
          'x-real-ip': '203.0.113.3',
        }),
        environment('production'),
      ),
    ).toBe('198.51.100.40');
  });

  it('uses the socket address for localhost and explicit test fixtures', () => {
    expect(
      clientIp(
        request('::ffff:127.0.0.1', { 'x-booknowtech-client-ip': '203.0.113.10' }),
        testEnvironment,
      ),
    ).toBe('127.0.0.1');
  });

  it.each([
    [{}, 'unknown'],
    [{ 'x-booknowtech-client-ip': 'not-an-ip' }, 'unknown'],
    [{ 'x-booknowtech-client-ip': '203.0.113.4, 203.0.113.5' }, 'unknown'],
  ])('fails closed for a missing or malformed canonical header', (headers, expected) => {
    expect(clientIp(request('10.0.0.8', headers), environment('staging'))).toBe(expected);
  });
});

function request(remoteAddress: string, headers: Record<string, string>): FastifyRequest {
  return {
    headers,
    raw: { socket: { remoteAddress } },
  } as unknown as FastifyRequest;
}

function environment(nodeEnvironment: Environment['NODE_ENV']): Environment {
  return { ...testEnvironment, NODE_ENV: nodeEnvironment };
}
