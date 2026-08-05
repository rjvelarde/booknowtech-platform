import { describe, expect, it } from 'vitest';

import { assertStagingSeedAllowed } from './seed-guard.js';

const approved = {
  NODE_ENV: 'staging',
  ENVIRONMENT_ID: 'staging',
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  MONGODB_DATABASE: 'booknowtech_staging',
  ALLOW_DEVELOPMENT_SEED: 'true',
};

describe('staging seed guard', () => {
  it('permits only an explicitly approved staging target', () => {
    expect(() => assertStagingSeedAllowed(approved)).not.toThrow();
  });

  it.each([
    ['production NODE_ENV', { NODE_ENV: 'production' }],
    ['production environment', { ENVIRONMENT_ID: 'production' }],
    ['Railway production', { RAILWAY_ENVIRONMENT_NAME: 'production' }],
    ['production database', { MONGODB_DATABASE: 'booknowtech_production' }],
    ['missing approval', { ALLOW_DEVELOPMENT_SEED: undefined }],
  ])('rejects %s before database setup', (_label, change) => {
    expect(() => assertStagingSeedAllowed({ ...approved, ...change })).toThrow(
      'Staging seed is prohibited',
    );
  });

  it('supports a non-Railway staging operator command', () => {
    const outsideRailway: NodeJS.ProcessEnv = { ...approved };
    delete outsideRailway.RAILWAY_ENVIRONMENT_NAME;
    expect(() => assertStagingSeedAllowed(outsideRailway)).not.toThrow();
  });
});
