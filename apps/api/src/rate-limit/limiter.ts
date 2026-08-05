import { createHmac } from 'node:crypto';
import type { Collection, Db, ObjectId } from 'mongodb';

const MAX_SUBJECT_LENGTH = 2_048;

export interface RateLimitRequest {
  scope: string;
  tenantKey: string;
  subject: string;
  limit: number;
  windowMilliseconds: number;
  now?: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
  bucketStartedAt: Date;
}

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
  tenantKey(value: string): string;
}

interface RateLimitDocument {
  _id: ObjectId;
  scope: string;
  tenant_key: string;
  subject_hash: string;
  bucket_started_at: Date;
  count: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export class MongoRateLimiter implements RateLimiter {
  private readonly collection: Collection<RateLimitDocument>;

  public constructor(
    db: Db,
    private readonly secret: string,
  ) {
    this.collection = db.collection<RateLimitDocument>('request_rate_limits');
  }

  public tenantKey(value: string): string {
    return `h:${hashRateLimitSubject(this.secret, `tenant:${bounded(value)}`).slice(0, 32)}`;
  }

  public async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    validateRequest(request);
    const now = request.now ?? new Date();
    const bucketMilliseconds =
      Math.floor(now.getTime() / request.windowMilliseconds) * request.windowMilliseconds;
    const bucketStartedAt = new Date(bucketMilliseconds);
    const resetsAt = new Date(bucketMilliseconds + request.windowMilliseconds);
    const expiresAt = new Date(bucketMilliseconds + request.windowMilliseconds * 2);
    const filter = {
      scope: request.scope,
      tenant_key: request.tenantKey,
      subject_hash: hashRateLimitSubject(this.secret, `subject:${bounded(request.subject)}`),
      bucket_started_at: bucketStartedAt,
    };
    const update = {
      $inc: { count: 1 },
      $set: { updated_at: now },
      $setOnInsert: {
        scope: request.scope,
        tenant_key: request.tenantKey,
        subject_hash: filter.subject_hash,
        bucket_started_at: bucketStartedAt,
        expires_at: expiresAt,
        created_at: now,
      },
    };
    let document: RateLimitDocument | null;
    try {
      document = await this.collection.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: 'after',
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      document = await this.collection.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
      });
    }
    if (!document) throw new Error('Rate-limit counter was not returned');
    return {
      allowed: document.count <= request.limit,
      count: document.count,
      limit: request.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1_000)),
      bucketStartedAt,
    };
  }
}

export function hashRateLimitSubject(secret: string, value: string): string {
  if (secret.length < 32) throw new Error('Rate-limit secret is invalid');
  return createHmac('sha256', secret).update(bounded(value)).digest('hex');
}

export const allowAllRateLimiter: RateLimiter = {
  tenantKey: () => 'test',
  consume: ({ limit, now = new Date(), windowMilliseconds }) =>
    Promise.resolve({
      allowed: true,
      count: 1,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil(windowMilliseconds / 1_000)),
      bucketStartedAt: now,
    }),
};

function bounded(value: string): string {
  if (value.length < 1 || value.length > MAX_SUBJECT_LENGTH)
    throw new Error('Rate-limit subject is invalid');
  return value;
}

function validateRequest(request: RateLimitRequest): void {
  if (!/^[a-z0-9_.-]{1,64}$/u.test(request.scope)) throw new Error('Rate-limit scope is invalid');
  if (!/^[a-z0-9:.-]{1,128}$/u.test(request.tenantKey))
    throw new Error('Rate-limit tenant key is invalid');
  bounded(request.subject);
  if (!Number.isSafeInteger(request.limit) || request.limit < 1)
    throw new Error('Rate-limit limit is invalid');
  if (!Number.isSafeInteger(request.windowMilliseconds) || request.windowMilliseconds < 1_000)
    throw new Error('Rate-limit window is invalid');
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11_000;
}
