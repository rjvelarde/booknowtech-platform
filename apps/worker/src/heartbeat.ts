import { randomUUID } from 'node:crypto';

import type { Collection, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';

import type { WorkerEnvironment } from './config.js';

export const HEARTBEAT_INTERVAL_MILLISECONDS = 30_000;
export const HEARTBEAT_TTL_MILLISECONDS = 600_000;

interface ServiceHeartbeatDocument {
  _id: ObjectId;
  service: 'worker';
  environment: WorkerEnvironment['ENVIRONMENT_ID'];
  commit_sha: string;
  instance_id: string;
  observed_at: Date;
  expires_at: Date;
}

export interface WorkerHeartbeat {
  instanceId: string;
  stop(): Promise<void>;
}

export async function startWorkerHeartbeat(
  db: Db,
  environment: WorkerEnvironment,
  logger: Logger,
): Promise<WorkerHeartbeat> {
  const collection = db.collection<ServiceHeartbeatDocument>('service_heartbeats');
  const instanceId = randomUUID();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (!stopped)
      timer = setTimeout(() => void writeAndSchedule(), HEARTBEAT_INTERVAL_MILLISECONDS);
  };
  const writeAndSchedule = async () => {
    if (stopped) return;
    active = writeHeartbeat(collection, environment, instanceId, logger);
    await active;
    schedule();
  };

  await writeAndSchedule();

  return {
    instanceId,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}

async function writeHeartbeat(
  collection: Collection<ServiceHeartbeatDocument>,
  environment: WorkerEnvironment,
  instanceId: string,
  logger: Logger,
): Promise<void> {
  const observedAt = new Date();
  try {
    await collection.updateOne(
      {
        service: 'worker',
        environment: environment.ENVIRONMENT_ID,
        instance_id: instanceId,
      },
      {
        $set: {
          service: 'worker',
          environment: environment.ENVIRONMENT_ID,
          commit_sha: environment.BUILD_VERSION,
          instance_id: instanceId,
          observed_at: observedAt,
          expires_at: new Date(observedAt.valueOf() + HEARTBEAT_TTL_MILLISECONDS),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn({
      event: 'service.heartbeat_write_failed',
      error_name: error instanceof Error ? error.name : 'unknown',
    });
  }
}
