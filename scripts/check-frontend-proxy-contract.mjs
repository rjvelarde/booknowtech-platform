import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';

const image = process.env.FRONTEND_PROXY_IMAGE ?? 'booknowtech-frontend-security-test';
const frontendPort = Number(process.env.FRONTEND_PROXY_PORT ?? 19082);
const apiPort = Number(process.env.FRONTEND_PROXY_API_PORT ?? 19083);
const container = `booknowtech-proxy-contract-${randomUUID()}`;
const received = [];

const webhookSecret = 'whsec_proxy_contract_fixture';
const api = createServer(async (incoming, response) => {
  const body = await readBody(incoming);
  received.push({
    body,
    headers: incoming.headers,
    method: incoming.method,
    rawHeaders: incoming.rawHeaders,
    url: incoming.url,
  });
  response.setHeader('content-type', 'application/json');
  response.setHeader('x-request-id', incoming.headers['x-request-id'] ?? 'generated-request-id');
  if (incoming.url === '/health/ready') {
    response.end(JSON.stringify({ data: { status: 'ready' } }));
    return;
  }
  if (incoming.url === '/health/ready?state=unhealthy') {
    response.statusCode = 503;
    response.end(JSON.stringify({ data: { status: 'not_ready' } }));
    return;
  }
  if (incoming.url === '/api/v1/proxy-contract') {
    response.end(JSON.stringify({ data: { status: 'captured' } }));
    return;
  }
  if (
    incoming.method === 'POST' &&
    ['/webhooks/stripe/platform', '/webhooks/stripe/connect'].includes(incoming.url ?? '')
  ) {
    const signature = incoming.headers['stripe-signature'];
    const timestamp =
      typeof signature === 'string' ? signature.match(/(?:^|,)t=([0-9]+)/u)?.[1] : null;
    const expected = timestamp
      ? createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(body).digest('hex')
      : null;
    if (typeof signature !== 'string' || !expected || !signature.includes(`v1=${expected}`)) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { code: 'invalid_signature' } }));
      return;
    }
    response.end(JSON.stringify({ received: true }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { code: 'not_found' } }));
});

await listen(api, apiPort);
try {
  await command('docker', [
    'run',
    '--detach',
    '--rm',
    '--network',
    'host',
    '--name',
    container,
    '--env',
    `PORT=${frontendPort}`,
    '--env',
    `API_PRIVATE_ORIGIN=http://127.0.0.1:${apiPort}`,
    image,
  ]);

  await waitUntilReady();
  const webhookBody = Buffer.from('{"id":"evt_proxy","nested":{"spacing":"preserved"}}\n');
  const timestamp = '1724929200';
  const digest = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.`)
    .update(webhookBody)
    .digest('hex');
  for (const path of ['/webhooks/stripe/platform', '/webhooks/stripe/connect']) {
    const webhook = await requestFrontend(
      'POST',
      path,
      {
        host: 'admin.booknowtech.com',
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${digest}`,
        'x-forwarded-for': '192.0.2.200',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'ftp',
        'x-real-ip': '198.51.100.25',
        'x-booknowtech-client-ip': '192.0.2.202',
      },
      webhookBody,
    );
    assertResponse(webhook, 200, { received: true });
    const capturedWebhook = received.at(-1);
    if (
      capturedWebhook?.method !== 'POST' ||
      capturedWebhook.url !== path ||
      !capturedWebhook.body.equals(webhookBody) ||
      capturedWebhook.headers['content-type'] !== 'application/json' ||
      capturedWebhook.headers['stripe-signature'] !== `t=${timestamp},v1=${digest}`
    )
      throw new Error(
        'Webhook method, path, raw body, content type, or signature was not preserved',
      );
    assertSanitizedForwardingHeaders(capturedWebhook, '198.51.100.25');
  }

  const webhookUpstreamCount = received.length;
  for (const requestCase of [
    ['GET', '/webhooks/stripe/platform', 'admin.booknowtech.com'],
    ['POST', '/webhooks/stripe/unknown', 'admin.booknowtech.com'],
    ['POST', '/webhooks/stripe/platform', 'tenant.booknowtech.com'],
  ]) {
    const refused = await requestFrontend(
      requestCase[0],
      requestCase[1],
      {
        host: requestCase[2],
        'content-type': 'application/json',
      },
      webhookBody,
    );
    if (![404, 405].includes(refused.status))
      throw new Error('Unsupported webhook request did not fail safely');
  }
  if (received.length !== webhookUpstreamCount)
    throw new Error('Unsupported method, path, or hostname reached the webhook API');
  const normalApi = await requestFrontend('GET', '/api/v1/proxy-contract', {
    host: 'admin.booknowtech.com',
    'x-forwarded-for': '192.0.2.200, 203.0.113.99, 100.64.0.5',
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'ftp',
    'x-real-ip': '198.51.100.25',
    'x-booknowtech-client-ip': '192.0.2.202',
  });
  assertResponse(normalApi, 200, { data: { status: 'captured' } });

  const captured = received.at(-1);
  if (!captured) throw new Error('API did not receive the proxied request');
  assertHeader(captured, 'x-booknowtech-client-ip', '198.51.100.25');
  assertAbsent(captured, 'x-forwarded-for');
  assertAbsent(captured, 'x-forwarded-host');
  assertAbsent(captured, 'x-forwarded-proto');
  assertAbsent(captured, 'x-real-ip');
  const canonicalHeaderCount = captured.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'x-booknowtech-client-ip',
  ).length;
  if (canonicalHeaderCount !== 1) {
    throw new Error(
      `Expected exactly one canonical client-IP header; received ${canonicalHeaderCount}`,
    );
  }

  const requestId = randomUUID();
  for (const host of [
    'admin.booknowtech.com',
    'admin.staging.booknowtech.com',
    'book.customer-domain.test',
  ]) {
    const healthy = await requestFrontend('GET', '/api/health/ready', {
      host,
      'x-request-id': requestId,
      'x-forwarded-for': '192.0.2.200',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'ftp',
      'x-real-ip': '198.51.100.25',
      'x-booknowtech-client-ip': '192.0.2.202',
    });
    assertResponse(healthy, 200, { data: { status: 'ready' } });
    assertHeaderValue(healthy.headers, 'x-request-id', requestId);
    assertPrivateOriginAbsent(healthy);

    const readiness = received.at(-1);
    if (!readiness) throw new Error('API did not receive the readiness request');
    if (readiness.method !== 'GET' || readiness.url !== '/health/ready') {
      throw new Error(
        `Readiness reached the API as ${readiness.method} ${readiness.url}; expected GET /health/ready`,
      );
    }
    assertSanitizedForwardingHeaders(readiness, '198.51.100.25');
  }

  const unhealthy = await requestFrontend('GET', '/api/health/ready?state=unhealthy', {
    host: 'admin.booknowtech.com',
    'x-request-id': requestId,
  });
  assertResponse(unhealthy, 503, { data: { status: 'not_ready' } });
  assertHeaderValue(unhealthy.headers, 'x-request-id', requestId);
  assertPrivateOriginAbsent(unhealthy);

  const nonGet = await requestFrontend('POST', '/api/health/ready', {
    host: 'admin.booknowtech.com',
  });
  assertResponse(nonGet, 404, { error: { code: 'not_found' } });
  const nonGetUpstream = received.at(-1);
  if (nonGetUpstream?.method !== 'POST' || nonGetUpstream.url !== '/api/health/ready') {
    throw new Error('Non-GET readiness request unexpectedly used the readiness rewrite');
  }

  const live = await requestFrontend('GET', '/api/health/live', {
    host: 'admin.booknowtech.com',
  });
  assertResponse(live, 404, { error: { code: 'not_found' } });
  if (received.at(-1)?.url !== '/api/health/live') {
    throw new Error('A non-readiness health route was unexpectedly rewritten');
  }

  const upstreamCount = received.length;
  const privatePath = await requestFrontend('GET', '/health/ready', {
    host: 'admin.booknowtech.com',
  });
  if (privatePath.status !== 200 || !privatePath.headers['content-type']?.startsWith('text/html')) {
    throw new Error('Private /health/ready did not remain outside the API proxy');
  }
  if (received.length !== upstreamCount) {
    throw new Error('Private /health/ready unexpectedly reached the API');
  }

  process.stdout.write(
    'Caddy proxy contract verified: exact GET readiness rewrite, status/body/request-ID pass-through, hostname parity, private health boundaries, method restriction, and forwarding-header sanitization.\n',
  );
} finally {
  await command('docker', ['stop', container], true);
  await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
}

function assertHeader(captured, name, expected) {
  if (captured.headers[name] !== expected) {
    throw new Error(`${name} was ${JSON.stringify(captured.headers[name])}; expected ${expected}`);
  }
}

function assertAbsent(captured, name) {
  if (captured.headers[name] !== undefined) {
    throw new Error(`${name} reached the API as ${JSON.stringify(captured.headers[name])}`);
  }
}

function assertSanitizedForwardingHeaders(captured, expectedClientIp) {
  assertHeader(captured, 'x-booknowtech-client-ip', expectedClientIp);
  assertAbsent(captured, 'x-forwarded-for');
  assertAbsent(captured, 'x-forwarded-host');
  assertAbsent(captured, 'x-forwarded-proto');
  assertAbsent(captured, 'x-real-ip');
  const canonicalHeaderCount = captured.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'x-booknowtech-client-ip',
  ).length;
  if (canonicalHeaderCount !== 1) {
    throw new Error(
      `Expected exactly one canonical client-IP header; received ${canonicalHeaderCount}`,
    );
  }
}

function assertResponse(response, expectedStatus, expectedBody) {
  if (response.status !== expectedStatus) {
    throw new Error(`Response status was ${response.status}; expected ${expectedStatus}`);
  }
  const actual = JSON.parse(response.body);
  if (JSON.stringify(actual) !== JSON.stringify(expectedBody)) {
    throw new Error(
      `Response body was ${JSON.stringify(actual)}; expected ${JSON.stringify(expectedBody)}`,
    );
  }
}

function assertHeaderValue(headers, name, expected) {
  if (headers[name] !== expected) {
    throw new Error(`${name} was ${JSON.stringify(headers[name])}; expected ${expected}`);
  }
}

function assertPrivateOriginAbsent(response) {
  const rendered = `${JSON.stringify(response.headers)}\n${response.body}`;
  if (rendered.includes('127.0.0.1') || rendered.includes('API_PRIVATE_ORIGIN')) {
    throw new Error('Response exposed the private API origin');
  }
}

function requestFrontend(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: '127.0.0.1', port: frontendPort, path, method, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function readBody(incoming) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await requestFrontend('GET', '/', { host: 'admin.booknowtech.com' });
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Frontend container did not become ready: ${lastError ?? 'unknown error'}`);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function command(executable, arguments_, tolerateFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => (tolerateFailure ? resolve() : reject(error)));
    child.once('close', (code) => {
      if (code === 0 || tolerateFailure) {
        resolve(Buffer.concat(stdout).toString('utf8').trim());
        return;
      }
      reject(
        new Error(
          `${executable} ${arguments_.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      );
    });
  });
}
