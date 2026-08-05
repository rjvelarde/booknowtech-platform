import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';

const image = process.env.FRONTEND_PROXY_IMAGE ?? 'booknowtech-frontend-security-test';
const frontendPort = Number(process.env.FRONTEND_PROXY_PORT ?? 19082);
const apiPort = Number(process.env.FRONTEND_PROXY_API_PORT ?? 19083);
const container = `booknowtech-proxy-contract-${randomUUID()}`;
const received = [];

const api = createServer((incoming, response) => {
  received.push({ headers: incoming.headers, rawHeaders: incoming.rawHeaders });
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ data: { status: 'captured' } }));
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
  await get('/api/v1/proxy-contract', {
    host: 'admin.booknowtech.com',
    'x-forwarded-for': '192.0.2.200, 198.51.100.25, 100.64.0.5',
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'ftp',
    'x-real-ip': '192.0.2.201',
    'x-booknowtech-client-ip': '192.0.2.202',
  });

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

  process.stdout.write(
    'Caddy proxy contract verified: spoofable forwarding headers removed and one canonical client IP forwarded.\n',
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

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: '127.0.0.1', port: frontendPort, path, method: 'GET', headers },
      (response) => {
        response.resume();
        response.on('end', resolve);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await get('/', { host: 'admin.booknowtech.com' });
      if (response === undefined) return;
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
