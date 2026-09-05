import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client.js';
import { publicSettingsErrorMessage } from './PublicBookingSettingsPage.js';

describe('public booking settings errors', () => {
  it('renders a field-specific save message without reporting a load failure', () => {
    const error = new ApiError(400, 'validation_failed', {
      field: 'public_profile.website_url',
    });

    expect(publicSettingsErrorMessage(error)).toBe(
      'Unable to save public booking settings. Check the public website and try again.',
    );
  });

  it('uses a safe generic save message when no field is available', () => {
    expect(publicSettingsErrorMessage(new ApiError(400, 'validation_failed'))).toBe(
      'Unable to save public booking settings. Check the entered values and try again.',
    );
    expect(publicSettingsErrorMessage(new Error('network'))).toBe(
      'Unable to save public booking settings. Please try again.',
    );
  });
});
