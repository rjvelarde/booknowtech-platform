import { describe, expect, it } from 'vitest';

import { buildAppointmentManagementUrl, buildPostmarkMetadata } from './notification-worker.js';

describe('buildPostmarkMetadata', () => {
  it('uses a Postmark-compatible metadata field name', () => {
    const metadata = buildPostmarkMetadata('28c93e87-3f11-4864-ac8a-d510f9e557fd');

    expect(metadata).toEqual({
      notice_id: '28c93e87-3f11-4864-ac8a-d510f9e557fd',
    });
    expect(Object.keys(metadata).every((fieldName) => fieldName.length <= 20)).toBe(true);
    expect(Object.values(metadata).every((value) => value.length <= 80)).toBe(true);
  });

  it('generates management links from the snapshotted origin', () => {
    expect(
      buildAppointmentManagementUrl(
        'https://book.customer.example',
        'token-id',
        'credential_value',
      ),
    ).toBe('https://book.customer.example/appointments/manage/token-id#token=credential_value');
  });

  it('preserves a snapshotted fallback origin without reconstructing it', () => {
    expect(
      buildAppointmentManagementUrl(
        'https://tenant-slug.staging.booknowtech.com',
        'token-id',
        'credential_value',
      ),
    ).toBe(
      'https://tenant-slug.staging.booknowtech.com/appointments/manage/token-id#token=credential_value',
    );
  });

  it('rejects an unsafe snapshotted origin', () => {
    expect(
      buildAppointmentManagementUrl('http://book.customer.example', 'token-id', 'credential'),
    ).toBeNull();
    expect(buildAppointmentManagementUrl(null, 'token-id', 'credential')).toBeNull();
  });
});
