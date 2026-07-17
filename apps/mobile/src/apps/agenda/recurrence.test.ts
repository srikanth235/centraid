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

// Shared parity fixtures — the SAME rules + windows are asserted against the
// server projection in packages/vault recurrence/rrule.test.ts, and the
// expected occurrence sets below are exactly what that server projection
// (packages/blueprints agenda/queries/upcoming.js → expandRrule) emits. If
// either side drifts, its suite fails against this shared ground truth.
const PARITY: readonly {
  name: string;
  rrule: string;
  start: string;
  from: string;
  to: string;
  expected: readonly string[];
}[] = [
  {
    name: 'monthly anchored on the 31st clamps short months',
    rrule: 'FREQ=MONTHLY;COUNT=4',
    start: '2026-01-31T09:00:00Z',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T00:00:00Z',
    expected: [
      '2026-01-31T09:00:00.000Z',
      '2026-02-28T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
      '2026-04-30T09:00:00.000Z',
    ],
  },
  {
    name: 'monthly anchored on the 30th',
    rrule: 'FREQ=MONTHLY;COUNT=3',
    start: '2026-01-30T09:00:00Z',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T00:00:00Z',
    expected: ['2026-01-30T09:00:00.000Z', '2026-02-28T09:00:00.000Z', '2026-03-30T09:00:00.000Z'],
  },
  {
    name: 'monthly anchored on the 29th',
    rrule: 'FREQ=MONTHLY;COUNT=3',
    start: '2026-01-29T09:00:00Z',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T00:00:00Z',
    expected: ['2026-01-29T09:00:00.000Z', '2026-02-28T09:00:00.000Z', '2026-03-29T09:00:00.000Z'],
  },
  {
    name: 'yearly Feb 29 clamps to Feb 28 on common years',
    rrule: 'FREQ=YEARLY;COUNT=3',
    start: '2024-02-29T09:00:00Z',
    from: '2024-01-01T00:00:00Z',
    to: '2030-01-01T00:00:00Z',
    expected: ['2024-02-29T09:00:00.000Z', '2025-02-28T09:00:00.000Z', '2026-02-28T09:00:00.000Z'],
  },
  {
    name: 'UNTIL in extended RFC form bounds the series',
    rrule: 'FREQ=DAILY;UNTIL=2026-07-03T00:00:00Z',
    start: '2026-07-01T00:00:00Z',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    expected: ['2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z'],
  },
  {
    name: 'UNTIL in RFC basic form (ICS verbatim) bounds identically',
    rrule: 'FREQ=DAILY;UNTIL=20260703T000000Z',
    start: '2026-07-01T00:00:00Z',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    expected: ['2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z'],
  },
  {
    name: 'unsorted BYDAY keeps every in-window weekday',
    rrule: 'FREQ=WEEKLY;BYDAY=FR,MO',
    start: '2026-07-06T09:00:00Z',
    from: '2026-07-06T00:00:00Z',
    to: '2026-07-18T00:00:00Z',
    expected: [
      '2026-07-06T09:00:00.000Z',
      '2026-07-10T09:00:00.000Z',
      '2026-07-13T09:00:00.000Z',
      '2026-07-17T09:00:00.000Z',
    ],
  },
  {
    name: 'INTERVAL strides the cadence',
    rrule: 'FREQ=DAILY;INTERVAL=3;COUNT=4',
    start: '2026-07-01T09:00:00Z',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    expected: [
      '2026-07-01T09:00:00.000Z',
      '2026-07-04T09:00:00.000Z',
      '2026-07-07T09:00:00.000Z',
      '2026-07-10T09:00:00.000Z',
    ],
  },
  {
    name: 'a far-past daily anchor still surfaces its in-window rows',
    rrule: 'FREQ=DAILY',
    start: '2026-01-01T09:00:00Z',
    from: '2026-07-01T00:00:00Z',
    to: '2026-07-05T00:00:00Z',
    expected: [
      '2026-07-01T09:00:00.000Z',
      '2026-07-02T09:00:00.000Z',
      '2026-07-03T09:00:00.000Z',
      '2026-07-04T09:00:00.000Z',
    ],
  },
  {
    name: 'an exhausted COUNT series yields nothing beyond its span',
    rrule: 'FREQ=DAILY;COUNT=2',
    start: '2026-01-01T09:00:00Z',
    from: '2026-07-01T00:00:00Z',
    to: '2026-07-05T00:00:00Z',
    expected: [],
  },
];

test.each(PARITY)('native expansion matches the server projection: $name', (fixture) => {
  const anchor = new Date(fixture.start);
  const rows = expandEvent(
    {
      id: 'series',
      summary: 'Fixture',
      start: fixture.start,
      end: new Date(anchor.getTime() + 30 * 60 * 1000).toISOString(),
      rrule: fixture.rrule,
      status: 'confirmed',
    },
    new Date(fixture.from),
    new Date(fixture.to),
  );
  expect(rows.map((row) => row.start)).toEqual(fixture.expected);
});

test('an exhausted series terminates the walk instead of spinning to the guard', () => {
  // Regression for the old 10k-step outer walk: an anchored-far-past COUNT=1
  // series must return immediately once its single occurrence is consumed.
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) {
    expandEvent(
      {
        id: 'series',
        summary: 'Once',
        start: '2000-01-01T09:00:00Z',
        end: '2000-01-01T09:30:00Z',
        rrule: 'FREQ=DAILY;COUNT=1',
        status: 'confirmed',
      },
      new Date('2026-07-01T00:00:00Z'),
      new Date('2026-08-01T00:00:00Z'),
    );
  }
  // 500 expansions of an exhausted series complete well under a second; the
  // pre-fix walk spun 10k empty steps each and blew past this bound.
  expect(performance.now() - started).toBeLessThan(500);
});
