const frontendUrl = requiredUrl('STAGING_FRONTEND_URL');
const apiUrl = requiredUrl('STAGING_API_URL');
const expectedVersion = process.env.EXPECTED_BUILD_VERSION;

await checkLanding(frontendUrl);
await checkJson(new URL('/health/live', apiUrl), 200, (body) => body.data?.status === 'live');
await checkJson(new URL('/health/ready', apiUrl), 200, (body) => body.data?.status === 'ready');
await checkJson(
  new URL('/api/v1/version', apiUrl),
  200,
  (body) =>
    typeof body.data?.version === 'string' &&
    body.data.version.length > 0 &&
    (expectedVersion === undefined || body.data.version === expectedVersion),
);

process.stdout.write('Staging smoke checks passed.\n');

function requiredUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error(`${name} must use HTTPS outside localhost`);
  }
  return parsed;
}

async function checkLanding(baseUrl) {
  const response = await fetch(baseUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  if (!response.ok || !body.includes('BookNowTech Business Hub')) {
    throw new Error(`Landing check failed with status ${response.status}`);
  }
}

async function checkJson(url, expectedStatus, validate) {
  const response = await fetch(url, {
    headers: { 'x-request-id': crypto.randomUUID() },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (response.status !== expectedStatus || !validate(body)) {
    throw new Error(`${url.pathname} check failed with status ${response.status}`);
  }
  if (!response.headers.get('x-request-id')) {
    throw new Error(`${url.pathname} did not return a support correlation ID`);
  }
}
