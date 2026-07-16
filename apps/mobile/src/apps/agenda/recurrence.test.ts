import { expect, test } from 'vitest';
import { expandEvent } from './recurrence';

test('native Agenda materializes the same bounded weekly recurrence read model', () => {
  const rows = expandEvent(
    {
      id: 'series',
      summary: 'Standup',
      start: '2026-07-13T09:00:00Z',
      end: '2026-07-13T09:30:00Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
      status: 'confirmed',
    },
    new Date('2026-07-13'),
    new Date('2026-07-27'),
  );
  expect(rows.map((row) => row.start)).toEqual([
    '2026-07-13T09:00:00.000Z',
    '2026-07-15T09:00:00.000Z',
    '2026-07-20T09:00:00.000Z',
    '2026-07-22T09:00:00.000Z',
  ]);
  expect(rows[1]?.isRecurrenceInstance).toBe(true);
});
