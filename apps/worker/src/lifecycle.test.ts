import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerLifecycle } from './lifecycle.js';

describe('worker lifecycle', () => {
  it('waits for and reports a graceful termination signal', async () => {
    const target = new EventEmitter() as NodeJS.Process;
    const logger = { info: vi.fn(), fatal: vi.fn() };
    const lifecycle = createWorkerLifecycle(logger, target);

    target.emit('SIGTERM');

    await expect(lifecycle.waitForShutdown()).resolves.toBe('SIGTERM');
    expect(logger.fatal).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it('records unhandled failures and requests shutdown', async () => {
    const target = new EventEmitter() as NodeJS.Process;
    Object.defineProperty(target, 'exitCode', { value: undefined, writable: true });
    const logger = { info: vi.fn(), fatal: vi.fn() };
    const lifecycle = createWorkerLifecycle(logger, target);

    target.emit('unhandledRejection', new Error('failure'), Promise.resolve());

    await expect(lifecycle.waitForShutdown()).resolves.toBe('SIGTERM');
    expect(logger.fatal).toHaveBeenCalledOnce();
    expect(target.exitCode).toBe(1);
    lifecycle.dispose();
  });
});
