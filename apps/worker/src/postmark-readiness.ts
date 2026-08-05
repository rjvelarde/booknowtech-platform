import type { WorkerEnvironment } from './config.js';

export async function verifyPostmarkIdentity(
  environment: Pick<WorkerEnvironment, 'POSTMARK_SERVER_ID' | 'TRANSACTIONAL_EMAIL_TOKEN'>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher('https://api.postmarkapp.com/server', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Postmark-Server-Token': environment.TRANSACTIONAL_EMAIL_TOKEN,
    },
  });
  if (!response.ok) throw new Error(`Postmark readiness failed: provider_${response.status}`);
  const body = (await response.json()) as { ID?: unknown };
  if (body.ID !== environment.POSTMARK_SERVER_ID)
    throw new Error('Postmark readiness failed: POSTMARK_SERVER_ID');
}
