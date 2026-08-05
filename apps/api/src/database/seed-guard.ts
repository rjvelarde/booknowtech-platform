export function assertStagingSeedAllowed(source: NodeJS.ProcessEnv): void {
  const invalid: string[] = [];
  if (source.NODE_ENV !== 'staging') invalid.push('NODE_ENV');
  if (source.ENVIRONMENT_ID !== 'staging') invalid.push('ENVIRONMENT_ID');
  if (
    source.RAILWAY_ENVIRONMENT_NAME !== undefined &&
    source.RAILWAY_ENVIRONMENT_NAME !== 'staging'
  )
    invalid.push('RAILWAY_ENVIRONMENT_NAME');
  if (source.MONGODB_DATABASE !== 'booknowtech_staging') invalid.push('MONGODB_DATABASE');
  if (source.ALLOW_DEVELOPMENT_SEED !== 'true') invalid.push('ALLOW_DEVELOPMENT_SEED');
  if (invalid.length > 0)
    throw new Error(`Staging seed is prohibited by configuration: ${invalid.join(', ')}`);
}
