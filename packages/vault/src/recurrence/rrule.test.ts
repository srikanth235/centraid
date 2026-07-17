import { expect, test } from 'vitest';
import { expandRrule, nextOccurrence, parseRrule } from './rrule.js';

test('parseRrule reads FREQ/INTERVAL/COUNT/UNTIL/BYDAY', () => {
  expect(parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5')).toEqual({
    freq: 'WEEKLY',
    interval: 2,
    count: 5,
    until: undefined,
    byDay: ['MO', 'WE'],
  });
  expect(parseRrule('FREQ=DAILY;UNTIL=2026-12-31T00:00:00.000Z')).toMatchObject({
    freq: 'DAILY',
    interval: 1,
    until: '2026-12-31T00:00:00.000Z',
  });
  expect(parseRrule('not a rule')).toBeNull();
});

test('expandRrule DAILY walks every day in the range', () => {
  const hits = expandRrule(
    'FREQ=DAILY',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-06T00:00:00.000Z',
  );
  expect(hits).toEqual([
    '2026-01-01T09:00:00.000Z',
    '2026-01-02T09:00:00.000Z',
    '2026-01-03T09:00:00.000Z',
    '2026-01-04T09:00:00.000Z',
    '2026-01-05T09:00:00.000Z',
  ]);
});

test('expandRrule WEEKLY+BYDAY lands only on named weekdays', () => {
  // 2026-01-05 is a Monday.
  const hits = expandRrule(
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    '2026-01-05T09:00:00.000Z',
    '2026-01-05T00:00:00.000Z',
    '2026-01-19T00:00:00.000Z',
  );
  const weekdays = hits.map((h) => new Date(h).getUTCDay());
  expect(weekdays).toEqual([1, 3, 5, 1, 3, 5]);
});

test('expandRrule respects COUNT across the whole series, not just the window', () => {
  const hits = expandRrule(
    'FREQ=DAILY;COUNT=3',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
  );
  expect(hits).toHaveLength(3);
});

test('expandRrule respects UNTIL', () => {
  const hits = expandRrule(
    'FREQ=DAILY;UNTIL=2026-01-03T23:59:59.000Z',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-10T00:00:00.000Z',
  );
  expect(hits).toEqual([
    '2026-01-01T09:00:00.000Z',
    '2026-01-02T09:00:00.000Z',
    '2026-01-03T09:00:00.000Z',
  ]);
});

test('expandRrule MONTHLY clamps day-of-month into shorter months', () => {
  const hits = expandRrule(
    'FREQ=MONTHLY;COUNT=4',
    '2026-01-31T09:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  );
  expect(hits.map((h) => h.slice(0, 10))).toEqual([
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
});

test('expandRrule parses UNTIL in RFC basic form (ICS verbatim)', () => {
  // ICS ingest stores UNTIL as `20260703T000000Z`; Date.parse rejects it, so
  // the bound used to silently degrade to unbounded. Basic and extended must
  // clip the series identically.
  const basic = expandRrule(
    'FREQ=DAILY;UNTIL=20260703T000000Z',
    '2026-07-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
  );
  expect(basic).toEqual([
    '2026-07-01T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z',
    '2026-07-03T00:00:00.000Z',
  ]);
  expect(
    expandRrule(
      'FREQ=DAILY;UNTIL=2026-07-03T00:00:00Z',
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ),
  ).toEqual(basic);
});

// Shared parity fixtures — the SAME rules + windows are asserted against the
// native expansion in apps/mobile agenda/recurrence.test.ts. These expected
// occurrence sets are the single ground truth both projections must produce.
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

test.each(PARITY)('server projection matches the native expansion: $name', (fixture) => {
  // maxInstances pinned to the native 200 so both projections share the walk
  // guard; every fixture fits well inside it.
  expect(expandRrule(fixture.rrule, fixture.start, fixture.from, fixture.to, 200)).toEqual(
    fixture.expected,
  );
});

test('nextOccurrence finds the next hit strictly after the given date', () => {
  const next = nextOccurrence(
    'FREQ=WEEKLY',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T09:00:00.000Z',
  );
  expect(next).toBe('2026-01-08T09:00:00.000Z');
});

test('nextOccurrence returns null once COUNT is exhausted', () => {
  const next = nextOccurrence(
    'FREQ=DAILY;COUNT=1',
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T09:00:00.000Z',
  );
  expect(next).toBeNull();
});

test('nextOccurrence returns null for an unparseable rule', () => {
  expect(
    nextOccurrence('garbage', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ).toBeNull();
});
