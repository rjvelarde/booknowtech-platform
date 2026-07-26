export interface LifecycleLogger {
  info(data: Record<string, unknown>): void;
  fatal(data: Record<string, unknown>): void;
}

export interface WorkerLifecycle {
  waitForShutdown(): Promise<NodeJS.Signals>;
  dispose(): void;
}

export function createWorkerLifecycle(
  logger: LifecycleLogger,
  processTarget: NodeJS.Process = process,
): WorkerLifecycle {
  const keepAlive = setInterval(() => {
    // Keep the process active until a shutdown signal is received.
  }, 60_000);
  let resolveShutdown: ((signal: NodeJS.Signals) => void) | undefined;
  const shutdown = new Promise<NodeJS.Signals>((resolve) => {
    resolveShutdown = resolve;
  });

  const onSigterm = (): void => resolveShutdown?.('SIGTERM');
  const onSigint = (): void => resolveShutdown?.('SIGINT');
  const onUncaughtException = (error: Error): void => {
    logger.fatal({ event: 'process.uncaught_exception', err: error });
    processTarget.exitCode = 1;
    resolveShutdown?.('SIGTERM');
  };
  const onUnhandledRejection = (reason: unknown): void => {
    logger.fatal({ event: 'process.unhandled_rejection', err: reason });
    processTarget.exitCode = 1;
    resolveShutdown?.('SIGTERM');
  };

  processTarget.once('SIGTERM', onSigterm);
  processTarget.once('SIGINT', onSigint);
  processTarget.once('uncaughtException', onUncaughtException);
  processTarget.once('unhandledRejection', onUnhandledRejection);

  return {
    waitForShutdown: async () => shutdown,
    dispose: () => {
      clearInterval(keepAlive);
      processTarget.off('SIGTERM', onSigterm);
      processTarget.off('SIGINT', onSigint);
      processTarget.off('uncaughtException', onUncaughtException);
      processTarget.off('unhandledRejection', onUnhandledRejection);
    },
  };
}
