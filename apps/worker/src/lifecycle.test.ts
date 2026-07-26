import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerLifecycle } from './lifecycle.js';

describe('worker lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an active handle while waiting for shutdown', async () => {
    vi.useFakeTimers();
    const target = new EventEmitter() as NodeJS.Process;
    const logger = { info: vi.fn(), fatal: vi.fn() };
    const lifecycle = createWorkerLifecycle(logger, target);
    let settled = false;

    void lifecycle.waitForShutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'waits for and reports a graceful %s signal',
    async (signal) => {
      vi.useFakeTimers();
      const target = new EventEmitter() as NodeJS.Process;
      const logger = { info: vi.fn(), fatal: vi.fn() };
      const lifecycle = createWorkerLifecycle(logger, target);

      target.emit(signal);

      await expect(lifecycle.waitForShutdown()).resolves.toBe(signal);
      expect(logger.fatal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      lifecycle.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('records unhandled failures and requests shutdown', async () => {
    vi.useFakeTimers();
    const target = new EventEmitter() as NodeJS.Process;
    const logger = { info: vi.fn(), fatal: vi.fn() };
    const lifecycle = createWorkerLifecycle(logger, target);
    Object.defineProperty(target, 'exitCode', { value: undefined, writable: true });

    target.emit('unhandledRejection', new Error('failure'), Promise.resolve());

    await expect(lifecycle.waitForShutdown()).resolves.toBe('SIGTERM');
    expect(logger.fatal).toHaveBeenCalledOnce();
    expect(target.exitCode).toBe(1);
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
