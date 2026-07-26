import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDirectory = new URL('../apps/frontend/dist/', import.meta.url);
const prohibitedValues = [
  'MONGODB_URI',
  'API_PRIVATE_ORIGIN',
  'booknowtechapi.railway.internal',
  'server-secret-must-not-ship',
  'mongodb+srv://',
  'authorization',
];

for (const path of await listFiles(outputDirectory)) {
  if (!['.html', '.js', '.css', '.map'].includes(extname(path))) continue;
  const content = await readFile(path, 'utf8');
  const found = prohibitedValues.find((value) => content.includes(value));
  if (found) throw new Error(`Frontend output contains prohibited server configuration: ${found}`);
}

process.stdout.write('Frontend output contains no prohibited server configuration.\n');

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(fileURLToPath(directory), entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(new URL(`${entry.name}/`, directory))));
    else files.push(path);
  }
  return files;
}
