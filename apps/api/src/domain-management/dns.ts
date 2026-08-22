import { resolveTxt } from 'node:dns/promises';

export interface DnsTxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export const systemDnsTxtResolver: DnsTxtResolver = { resolveTxt };

export type DnsObservation =
  { kind: 'answers'; values: string[] } | { kind: 'not_found' } | { kind: 'temporary_failure' };

export async function observeTxt(resolver: DnsTxtResolver, name: string): Promise<DnsObservation> {
  try {
    return {
      kind: 'answers',
      values: (await resolver.resolveTxt(name)).map((chunks) => chunks.join('')),
    };
  } catch (error) {
    const code = typeof error === 'object' && error ? String(Reflect.get(error, 'code') ?? '') : '';
    return ['ENOTFOUND', 'ENODATA'].includes(code)
      ? { kind: 'not_found' }
      : { kind: 'temporary_failure' };
  }
}
