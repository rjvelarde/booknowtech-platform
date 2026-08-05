import { BlockList, isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

import type { Environment } from './config.js';

export const CANONICAL_CLIENT_IP_HEADER = 'x-booknowtech-client-ip';

const trustedProxyAddresses = new BlockList();
trustedProxyAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
trustedProxyAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
trustedProxyAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
trustedProxyAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
trustedProxyAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
trustedProxyAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
trustedProxyAddresses.addAddress('::1', 'ipv6');
trustedProxyAddresses.addSubnet('fc00::', 7, 'ipv6');
trustedProxyAddresses.addSubnet('fe80::', 10, 'ipv6');

export function isTrustedProxyAddress(address: string, _hop?: number): boolean {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  const family = isIP(normalized);
  return family === 4
    ? trustedProxyAddresses.check(normalized, 'ipv4')
    : trustedProxyAddresses.check(normalized, 'ipv6');
}

export function clientIp(request: FastifyRequest, environment: Environment): string {
  const socketAddress = normalizeIpAddress(request.raw.socket.remoteAddress);
  const productionPath =
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production';

  if (productionPath && socketAddress && isTrustedProxyAddress(socketAddress)) {
    const internalHeader = request.headers[CANONICAL_CLIENT_IP_HEADER];
    if (typeof internalHeader !== 'string') return 'unknown';
    return normalizeIpAddress(internalHeader) ?? 'unknown';
  }

  return socketAddress ?? 'unknown';
}

export function normalizeIpAddress(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.includes(',')) return null;
  if (value.startsWith('::ffff:')) {
    const ipv4 = value.slice('::ffff:'.length);
    return isIP(ipv4) === 4 ? ipv4 : null;
  }
  const family = isIP(value);
  if (family === 0) return null;
  if (family === 4) return value;
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}
