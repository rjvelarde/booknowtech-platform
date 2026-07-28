import { describe, expect, it } from 'vitest';

import { dateRange, previewDay, validateSchedule } from './routes.js';

describe('availability rules', () => {
  it('rejects overlaps and breaks outside working time', () => {
    expect(
      validateSchedule({
        timezone: 'America/New_York',
        weekly_hours: [
          { day_of_week: 1, start_minute: 540, end_minute: 720 },
          { day_of_week: 1, start_minute: 700, end_minute: 900 },
        ],
        breaks: [],
      }),
    ).toBe('overlapping_intervals');
    expect(
      validateSchedule({
        timezone: 'America/New_York',
        weekly_hours: [{ day_of_week: 1, start_minute: 540, end_minute: 900 }],
        breaks: [{ day_of_week: 1, start_minute: 500, end_minute: 550 }],
      }),
    ).toBe('break_outside_working_hours');
  });

  it('limits preview ranges to 31 inclusive dates', () => {
    expect(dateRange('2026-01-01', '2026-01-31')).toHaveLength(31);
    expect(dateRange('2026-01-01', '2026-02-01')).toBeUndefined();
  });

  it('subtracts breaks and returns UTC plus local timestamps', () => {
    const result = previewDay(
      '2026-07-27',
      {
        timezone: 'America/New_York',
        weekly_hours: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
        breaks: [{ day_of_week: 1, start_minute: 720, end_minute: 750 }],
      },
      [],
      30,
      5,
      10,
    );
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({
      starts_at: '2026-07-27T13:00:00.000Z',
      local_start: '2026-07-27T09:00:00-04:00',
      earliest_service_start_at: '2026-07-27T13:05:00.000Z',
    });
  });

  it('uses the defined fall-back and spring-forward boundary policies', () => {
    const fall = previewDay(
      '2026-11-01',
      {
        timezone: 'America/New_York',
        weekly_hours: [{ day_of_week: 7, start_minute: 60, end_minute: 120 }],
        breaks: [],
      },
      [],
      15,
      0,
      0,
    );
    expect(fall.windows[0]?.starts_at).toBe('2026-11-01T05:00:00.000Z');
    expect(fall.windows[0]?.ends_at).toBe('2026-11-01T07:00:00.000Z');
    const spring = previewDay(
      '2027-03-14',
      {
        timezone: 'America/New_York',
        weekly_hours: [{ day_of_week: 7, start_minute: 150, end_minute: 240 }],
        breaks: [],
      },
      [],
      15,
      0,
      0,
    );
    expect(spring.windows[0]?.starts_at).toBe('2027-03-14T07:00:00.000Z');
  });
});
