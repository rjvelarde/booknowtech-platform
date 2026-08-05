const FALLBACK_SUFFIX = '.booknowtech.com';
const DEVELOPMENT_SUFFIXES = ['.localhost', '.example.test'] as const;
const RESERVED_TENANT_LABELS = new Set(['admin', 'api', 'book', 'status', 'support', 'www']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DISALLOWED_INPUT = /[\s/@\\?#%]/u;

export function normalizeHostname(input: string): string | null {
  if (
    !input ||
    input !== input.trim() ||
    DISALLOWED_INPUT.test(input) ||
    hasControlCharacter(input)
  )
    return null;

  let candidate = input;
  const portSeparator = candidate.lastIndexOf(':');
  if (portSeparator >= 0) {
    if (candidate.indexOf(':') !== portSeparator) return null;
    const hostname = candidate.slice(0, portSeparator);
    const port = candidate.slice(portSeparator + 1);
    if (!approvedDevelopmentHostname(hostname) || !validPort(port)) return null;
    candidate = hostname;
  }

  if (candidate.endsWith('.')) candidate = candidate.slice(0, -1);
  if (!candidate || candidate.endsWith('.') || candidate.length > 253) return null;

  let ascii: string;
  try {
    ascii = new URL(`https://${candidate}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!ascii || ascii.length > 253 || ascii.includes(':')) return null;

  const labels = ascii.split('.');
  if (labels.some((label) => !DNS_LABEL.test(label))) return null;
  return ascii;
}

export function fallbackTenantSlug(hostname: string): string | null {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return null;

  const suffix = fallbackSuffix(normalized);
  if (!suffix) return null;
  const label = normalized.slice(0, -suffix.length);
  if (!label || label.includes('.') || RESERVED_TENANT_LABELS.has(label)) return null;
  return DNS_LABEL.test(label) ? label : null;
}

export function fallbackBookingHostname(slug: string): string | null {
  const normalized = normalizeTenantLabel(slug);
  return normalized ? `${normalized}${FALLBACK_SUFFIX}` : null;
}

export function fallbackBookingOrigin(slug: string): string | null {
  const hostname = fallbackBookingHostname(slug);
  return hostname ? `https://${hostname}` : null;
}

export function isAdministrativeHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'admin.booknowtech.com' ||
    normalized === 'admin.example.test' ||
    normalized === 'admin.localhost' ||
    normalized === 'localhost'
  );
}

function fallbackSuffix(hostname: string): string | null {
  if (hostname.endsWith(FALLBACK_SUFFIX)) return FALLBACK_SUFFIX;
  return DEVELOPMENT_SUFFIXES.find((suffix) => hostname.endsWith(suffix)) ?? null;
}

function normalizeTenantLabel(slug: string): string | null {
  if (!slug || slug !== slug.trim() || DISALLOWED_INPUT.test(slug) || hasControlCharacter(slug))
    return null;
  const normalized = slug.toLowerCase();
  if (RESERVED_TENANT_LABELS.has(normalized) || !DNS_LABEL.test(normalized)) return null;
  return normalized;
}

function approvedDevelopmentHostname(hostname: string): boolean {
  const withoutDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const lower = withoutDot.toLowerCase();
  return lower === 'localhost' || DEVELOPMENT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function validPort(value: string): boolean {
  if (!/^[0-9]{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
