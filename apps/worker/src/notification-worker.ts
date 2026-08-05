import type { Collection, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import {
  buildPublicAppointmentManagementUrl,
  derivePublicAppointmentCredential,
  fallbackBookingOrigin,
} from '@booknowtech/shared';

import type { WorkerEnvironment } from './config.js';
import {
  type AppointmentEmailTemplateData,
  type AppointmentEmailType,
  renderAppointmentEmail,
} from './templates.js';

interface OutboxDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_reference: string;
  type: AppointmentEmailType;
  recipient: string;
  template_data: AppointmentEmailTemplateData;
  appointment_access: { token_public_id: string; generation: number } | null;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempt_count: number;
  next_attempt_at: Date;
  processing_started_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  updated_at: Date;
  created_at: Date;
}

interface TenantEmailDocument {
  _id: ObjectId;
  public_id: string;
  slug: string;
  status: 'active' | 'inactive';
  appointment_email_settings: {
    enabled: boolean;
    sender_name: string;
    reply_to_email: string | null;
  };
  appointment_self_service?: { enabled: boolean };
}

const MAX_ATTEMPTS = 5;
const POLL_MILLISECONDS = 2_000;

export function buildPostmarkMetadata(notificationPublicId: string): Record<string, string> {
  return { notice_id: notificationPublicId };
}

export function buildFallbackAppointmentManagementUrl(
  tenantSlug: string,
  tokenPublicId: string,
  credential: string,
): string | null {
  const origin = fallbackBookingOrigin(tenantSlug);
  return origin ? buildPublicAppointmentManagementUrl(origin, tokenPublicId, credential) : null;
}

export function startNotificationWorker(
  db: Db,
  environment: WorkerEnvironment,
  logger: Logger,
): { stop(): Promise<void> } {
  const outbox = db.collection<OutboxDocument>('notification_outbox');
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> = Promise.resolve();
  const poll = async () => {
    if (stopped) return;
    active = processOne(outbox, db, environment, logger).catch((error: unknown) => {
      logger.error({
        event: 'notification.poll_failed',
        error_name: error instanceof Error ? error.name : 'unknown',
      });
    });
    await active;
    if (!stopped) timer = setTimeout(() => void poll(), POLL_MILLISECONDS);
  };
  void poll();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}

async function processOne(
  outbox: Collection<OutboxDocument>,
  db: Db,
  environment: WorkerEnvironment,
  logger: Logger,
) {
  const now = new Date();
  const item = await outbox.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', next_attempt_at: { $lte: now } },
        {
          status: 'processing',
          processing_started_at: { $lte: new Date(now.getTime() - 300_000) },
        },
      ],
    },
    { $set: { status: 'processing', processing_started_at: now, updated_at: now } },
    { sort: { next_attempt_at: 1, created_at: 1 }, returnDocument: 'after' },
  );
  if (!item) return;
  const tenant = await db
    .collection<TenantEmailDocument>('tenants')
    .findOne({ _id: item.tenant_id, status: 'active' });
  if (!tenant?.appointment_email_settings?.enabled) {
    await outbox.updateOne(
      { _id: item._id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          failed_at: new Date(),
          last_error_code: 'tenant_email_disabled',
          updated_at: new Date(),
        },
      },
    );
    return;
  }
  try {
    let managementUrl: string | null = null;
    if (item.appointment_access && tenant.appointment_self_service?.enabled) {
      const token = await db
        .collection<{
          public_id: string;
          appointment_public_id: string;
          generation: number;
          status: string;
        }>('appointment_public_access_tokens')
        .findOne({
          tenant_id: item.tenant_id,
          public_id: item.appointment_access.token_public_id,
          generation: item.appointment_access.generation,
          status: 'active',
        });
      if (token) {
        const credential = derivePublicAppointmentCredential(
          environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
          {
            version: 1,
            tokenPublicId: token.public_id,
            appointmentPublicId: token.appointment_public_id,
            generation: token.generation,
            purpose: 'appointment_management',
          },
        );
        managementUrl = buildFallbackAppointmentManagementUrl(
          tenant.slug,
          token.public_id,
          credential,
        );
      }
    }
    const rendered = renderAppointmentEmail(
      item.type,
      item.appointment_reference,
      item.template_data,
      managementUrl,
    );
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': environment.TRANSACTIONAL_EMAIL_TOKEN,
      },
      body: JSON.stringify({
        From: `${tenant.appointment_email_settings.sender_name} <${environment.TRANSACTIONAL_EMAIL_FROM}>`,
        To: item.recipient,
        ReplyTo: tenant.appointment_email_settings.reply_to_email ?? undefined,
        Subject: rendered.subject,
        HtmlBody: rendered.html,
        TextBody: rendered.text,
        MessageStream: 'outbound',
        Metadata: buildPostmarkMetadata(item.public_id),
      }),
    });
    if (!response.ok) throw new Error(`provider_${response.status}`);
    const body = (await response.json()) as { MessageID?: string };
    await outbox.updateOne(
      { _id: item._id, status: 'processing' },
      {
        $set: {
          status: 'delivered',
          delivered_at: new Date(),
          provider_message_id: body.MessageID ?? null,
          last_error_code: null,
          updated_at: new Date(),
        },
        $inc: { attempt_count: 1 },
      },
    );
    logger.info({
      event: 'notification.sent',
      notification_public_id: item.public_id,
      type: item.type,
    });
  } catch (reason) {
    const attempt = item.attempt_count + 1;
    const terminal = attempt >= MAX_ATTEMPTS;
    await outbox.updateOne(
      { _id: item._id, status: 'processing' },
      {
        $set: {
          status: terminal ? 'failed' : 'pending',
          next_attempt_at: new Date(Date.now() + Math.min(60, 2 ** attempt) * 60_000),
          processing_started_at: null,
          failed_at: terminal ? new Date() : null,
          last_error_code:
            reason instanceof Error ? reason.message.slice(0, 100) : 'provider_error',
          updated_at: new Date(),
        },
        $inc: { attempt_count: 1 },
      },
    );
    logger.warn({
      event: 'notification.retry_scheduled',
      notification_public_id: item.public_id,
      attempt,
      terminal,
    });
  }
}
