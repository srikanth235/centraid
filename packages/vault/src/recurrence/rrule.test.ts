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
  expect(hits).toEqual(['2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z', '2026-01-03T09:00:00.000Z']);
});

test('expandRrule MONTHLY clamps day-of-month into shorter months', () => {
  const hits = expandRrule(
    'FREQ=MONTHLY;COUNT=4',
    '2026-01-31T09:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  );
  expect(hits.map((h) => h.slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('nextOccurrence finds the next hit strictly after the given date', () => {
  const next = nextOccurrence('FREQ=WEEKLY', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z');
  expect(next).toBe('2026-01-08T09:00:00.000Z');
});

test('nextOccurrence returns null once COUNT is exhausted', () => {
  const next = nextOccurrence('FREQ=DAILY;COUNT=1', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z');
  expect(next).toBeNull();
});

test('nextOccurrence returns null for an unparseable rule', () => {
  expect(nextOccurrence('garbage', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBeNull();
});
