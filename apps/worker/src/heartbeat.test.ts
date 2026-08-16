import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerEnvironment } from './config.js';
import {
  HEARTBEAT_INTERVAL_MILLISECONDS,
  HEARTBEAT_TTL_MILLISECONDS,
  startWorkerHeartbeat,
} from './heartbeat.js';

const environment = {
  ENVIRONMENT_ID: 'staging',
  BUILD_VERSION: 'a'.repeat(40),
} as WorkerEnvironment;

afterEach(() => vi.useRealTimers());

describe('worker heartbeat', () => {
  it('writes immediately, refreshes after the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
    const db = fakeDb(updateOne);
    const logger = fakeLogger();

    const heartbeat = await startWorkerHeartbeat(db, environment, logger);

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(heartbeat.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(updateOne).toHaveBeenLastCalledWith(
      {
        service: 'worker',
        environment: 'staging',
        instance_id: heartbeat.instanceId,
      },
      {
        $set: {
          service: 'worker',
          environment: 'staging',
          commit_sha: 'a'.repeat(40),
          instance_id: heartbeat.instanceId,
          observed_at: new Date('2026-08-16T12:00:00.000Z'),
          expires_at: new Date(
            new Date('2026-08-16T12:00:00.000Z').valueOf() + HEARTBEAT_TTL_MILLISECONDS,
          ),
        },
      },
      { upsert: true },
    );

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MILLISECONDS);
    expect(updateOne).toHaveBeenCalledTimes(2);

    await heartbeat.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MILLISECONDS * 2);
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it('logs a safe warning and continues after a write failure', async () => {
    vi.useFakeTimers();
    const updateOne = vi
      .fn()
      .mockRejectedValueOnce(new Error('mongodb://user:password@example.test/private'))
      .mockResolvedValue({ acknowledged: true });
    const logger = fakeLogger();

    const heartbeat = await startWorkerHeartbeat(fakeDb(updateOne), environment, logger);

    expect(logger.warn).toHaveBeenCalledWith({
      event: 'service.heartbeat_write_failed',
      error_name: 'Error',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('password');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MILLISECONDS);
    expect(updateOne).toHaveBeenCalledTimes(2);
    await heartbeat.stop();
  });
});

function fakeDb(updateOne: ReturnType<typeof vi.fn>): Db {
  return {
    collection: vi.fn(() => ({ updateOne })),
  } as unknown as Db;
}

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}
