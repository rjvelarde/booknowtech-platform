import type { LoggerOptions } from 'pino';

import type { Environment } from './config.js';

export function createLoggerOptions(environment: Environment): LoggerOptions {
  return {
    level: environment.LOG_LEVEL,
    base: {
      service: 'booknowtech-api',
      environment: environment.NODE_ENV,
      version: environment.BUILD_VERSION,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.stripe-signature',
        'request.headers.authorization',
        'request.headers.cookie',
        'request.headers.stripe-signature',
        '*.password',
        '*.secret',
        '*.token',
        '*.credential',
        '*.MONGODB_URI',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request: { id?: string; method?: string; url?: string }) {
        return {
          request_id: request.id,
          method: request.method,
          path: request.url?.split('?')[0],
        };
      },
      err(error: Error) {
        return {
          type: error.name,
          message: error.message,
          stack: environment.NODE_ENV === 'production' ? undefined : error.stack,
        };
      },
    },
  };
}
