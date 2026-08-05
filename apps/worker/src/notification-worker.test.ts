import { describe, expect, it } from 'vitest';

import {
  buildFallbackAppointmentManagementUrl,
  buildPostmarkMetadata,
} from './notification-worker.js';

describe('buildPostmarkMetadata', () => {
  it('uses a Postmark-compatible metadata field name', () => {
    const metadata = buildPostmarkMetadata('28c93e87-3f11-4864-ac8a-d510f9e557fd');

    expect(metadata).toEqual({
      notice_id: '28c93e87-3f11-4864-ac8a-d510f9e557fd',
    });
    expect(Object.keys(metadata).every((fieldName) => fieldName.length <= 20)).toBe(true);
    expect(Object.values(metadata).every((value) => value.length <= 80)).toBe(true);
  });

  it('generates management links from the canonical fallback origin', () => {
    expect(
      buildFallbackAppointmentManagementUrl('Tenant-Slug', 'token-id', 'credential_value'),
    ).toBe(
      'https://tenant-slug.booknowtech.com/appointments/manage/token-id#token=credential_value',
    );
  });

  it('generates staging management links only when staging is configured', () => {
    expect(
      buildFallbackAppointmentManagementUrl(
        'Tenant-Slug',
        'token-id',
        'credential_value',
        'staging.booknowtech.com',
      ),
    ).toBe(
      'https://tenant-slug.staging.booknowtech.com/appointments/manage/token-id#token=credential_value',
    );
  });
});
