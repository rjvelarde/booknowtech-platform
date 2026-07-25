import { MongoClient } from 'mongodb';

export interface ReadinessProbe {
  check(): Promise<void>;
  close(): Promise<void>;
}

export class AtlasReadinessProbe implements ReadinessProbe {
  private readonly client: MongoClient;

  public constructor(uri: string, timeoutMilliseconds = 2_000) {
    this.client = new MongoClient(uri, {
      connectTimeoutMS: timeoutMilliseconds,
      serverSelectionTimeoutMS: timeoutMilliseconds,
    });
  }

  public async check(): Promise<void> {
    await this.client.db('admin').command({ ping: 1 });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}
