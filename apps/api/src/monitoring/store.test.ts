import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { MongoMonitoringReader } from './store.js';

describe('Mongo monitoring query timeout', () => {
  it('rejects a monitoring read when Mongo operations do not complete within the bound', async () => {
    const never = new Promise<never>(() => undefined);
    const collection = { findOne: () => never, countDocuments: () => never };
    const database = { collection: () => collection } as unknown as Db;

    await expect(
      new MongoMonitoringReader(database, 5).read('staging', new Date()),
    ).rejects.toThrow('Monitoring query timeout');
  });
});
