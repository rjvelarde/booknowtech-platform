import { MongoClient } from 'mongodb';

import { loadEnvironment } from '../config.js';
import { migrateDatabase } from './migrate.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const client = new MongoClient(environment.MONGODB_URI);
  try {
    await migrateDatabase(client.db(environment.MONGODB_DATABASE));
    process.stdout.write('MongoDB administrative foundation migration complete.\n');
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `MongoDB migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
