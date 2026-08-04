export interface AppointmentEmailTemplateData {
  business_name: string;
  business_logo_url: string | null;
  business_phone: string | null;
  business_email: string | null;
  business_website: string | null;
  customer_name: string;
  provider_name: string;
  provider_photo_url: string | null;
  service_name: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  location_mode: 'provider_location' | 'customer_location' | 'virtual';
}

export type AppointmentEmailType =
  'appointment_confirmation' | 'appointment_rescheduled' | 'appointment_cancelled';

export function renderAppointmentEmail(
  type: AppointmentEmailType,
  reference: string,
  data: AppointmentEmailTemplateData,
  managementUrl: string | null = null,
) {
  const heading =
    type === 'appointment_confirmation'
      ? 'Your appointment is confirmed'
      : type === 'appointment_rescheduled'
        ? 'Your appointment has been rescheduled'
        : 'Your appointment has been cancelled';
  const when = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: data.timezone,
  }).format(data.starts_at);
  const contact = [data.business_phone, data.business_email, data.business_website]
    .filter(Boolean)
    .join(' · ');
  const logo = data.business_logo_url
    ? `<img src="${escapeAttribute(data.business_logo_url)}" alt="${escapeAttribute(data.business_name)}" style="max-height:72px;max-width:220px">`
    : '';
  const summary = `${data.service_name} with ${data.provider_name} on ${when}`;
  const action = managementUrl
    ? `<p><a href="${escapeAttribute(managementUrl)}" style="display:inline-block;padding:12px 18px;background:#1261a0;color:#fff;text-decoration:none;border-radius:6px">Manage appointment</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#12203d"><table role="presentation" width="100%"><tr><td align="center" style="padding:24px"><table role="presentation" width="100%" style="max-width:620px;background:#fff;border:1px solid #dbe4f0;border-radius:12px"><tr><td style="padding:32px">${logo}<h1>${escapeHtml(data.business_name)}</h1><h2>${escapeHtml(heading)}</h2><p>Hello ${escapeHtml(data.customer_name)},</p><p>${escapeHtml(summary)}.</p><table role="presentation" width="100%" style="background:#eef4fb;border-radius:8px"><tr><td style="padding:18px"><strong>${escapeHtml(data.service_name)}</strong><br>${escapeHtml(when)}<br>Provider: ${escapeHtml(data.provider_name)}<br>Reference: <strong>${escapeHtml(reference)}</strong></td></tr></table>${action}${contact ? `<p style="color:#50617d">Questions? ${escapeHtml(contact)}</p>` : ''}</td></tr></table></td></tr></table></body></html>`;
  const text = `${data.business_name}\n\n${heading}\n\nHello ${data.customer_name},\n\n${summary}.\nReference: ${reference}${managementUrl ? `\n\nManage appointment: ${managementUrl}` : ''}${contact ? `\n\nQuestions? ${contact}` : ''}`;
  return { subject: `${heading} — ${data.business_name}`, html, text };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}
