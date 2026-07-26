const sensitiveKey =
  /(?:authorization|cookie|credential|mongodb_uri|password|secret|token|api[_-]?key|client[_-]?secret)/iu;
const redacted = '[REDACTED]';

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) ? redacted : redactSensitive(nested, seen),
    ]),
  );
}
