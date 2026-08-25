import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';

const image = process.env.FRONTEND_SECURITY_IMAGE ?? 'booknowtech-frontend-security-test';
const frontendPort = Number(process.env.FRONTEND_SECURITY_PORT ?? 19080);
const apiPort = Number(process.env.FRONTEND_SECURITY_API_PORT ?? 19081);
const container = `booknowtech-security-headers-${randomUUID()}`;
const expectedHeaders = {
  'content-security-policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; manifest-src 'self'; upgrade-insecure-requests; block-all-mixed-content",
  'strict-transport-security': 'max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-frame-options': 'DENY',
};

const api = createServer((incoming, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('x-request-id', incoming.headers['x-request-id'] ?? 'security-header-test');
  if (incoming.url === '/health/ready') {
    response.statusCode = 200;
    response.end(JSON.stringify({ data: { status: 'ready' } }));
    return;
  }
  if (incoming.url === '/health/ready?state=unhealthy') {
    response.statusCode = 503;
    response.end(JSON.stringify({ data: { status: 'not_ready' } }));
    return;
  }
  if (incoming.url === '/api/v1/version') {
    response.statusCode = 200;
    response.end(JSON.stringify({ data: { version: 'security-header-test' } }));
    return;
  }
  response.statusCode = 404;
  response.end(
    JSON.stringify({
      error: {
        code: 'not_found',
        message: 'The requested resource was not found.',
        request_id: 'security-header-test',
      },
    }),
  );
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
  const root = await verify('/', 'admin.booknowtech.com', 200, 'text/html');
  const assetPath = assetFrom(root.body);
  await verify(assetPath, 'admin.booknowtech.com', 200);
  await verify('/providers/operator/edit', 'admin.booknowtech.com', 200, 'text/html');
  await verify('/book', 'harbor-demo.booknowtech.com', 200, 'text/html');
  await verify('/book', 'book.customer-domain.test', 200, 'text/html');
  await verify(
    '/appointments/manage/11111111-1111-4111-8111-111111111111',
    'harbor-demo.booknowtech.com',
    200,
    'text/html',
  );
  await verify('/api/v1/version', 'admin.booknowtech.com', 200, 'application/json');
  const productionReady = await verify(
    '/api/health/ready',
    'admin.booknowtech.com',
    200,
    'application/json',
  );
  assertJson(productionReady.body, { data: { status: 'ready' } });
  const stagingReady = await verify(
    '/api/health/ready',
    'admin.staging.booknowtech.com',
    200,
    'application/json',
  );
  assertJson(stagingReady.body, { data: { status: 'ready' } });
  const unhealthy = await verify(
    '/api/health/ready?state=unhealthy',
    'admin.booknowtech.com',
    503,
    'application/json',
  );
  assertJson(unhealthy.body, { data: { status: 'not_ready' } });
  await verify(
    '/api/v1/security-header-probe-not-found',
    'harbor-demo.booknowtech.com',
    404,
    'application/json',
  );
  await verify(
    '/api/v1/security-header-probe-not-found',
    'book.customer-domain.test',
    404,
    'application/json',
  );

  process.stdout.write(
    'Frontend security headers verified on HTML, hashed assets, SPA fallbacks, host routes, and proxied API responses.\n',
  );
} finally {
  await command('docker', ['stop', container], true);
  await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
}

function assertJson(body, expected) {
  const actual = JSON.parse(body);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `JSON body was ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
}

async function verify(path, host, status, contentType) {
  const response = await get(path, host);
  if (response.status !== status) {
    throw new Error(`${host}${path} returned ${response.status}; expected ${status}`);
  }
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    const actual = response.headers[name];
    if (actual !== expected) {
      throw new Error(`${host}${path} ${name} was ${JSON.stringify(actual)}; expected ${expected}`);
    }
  }
  if (contentType && !response.headers['content-type']?.startsWith(contentType)) {
    throw new Error(
      `${host}${path} content-type was ${response.headers['content-type']}; expected ${contentType}`,
    );
  }
  return response;
}

function get(path, host) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port: frontendPort,
        path,
        method: 'GET',
        headers: { host },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function assetFrom(html) {
  const match = html.match(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/u);
  if (!match?.[1]) throw new Error('Frontend HTML did not contain a hashed asset');
  if (!/\/assets\/.+-[A-Za-z0-9_-]+\.(?:js|css)$/u.test(match[1])) {
    throw new Error(`Frontend asset is not content hashed: ${match[1]}`);
  }
  return match[1];
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await get('/', 'admin.booknowtech.com');
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
