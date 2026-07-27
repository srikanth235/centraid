// Minimal, self-contained 5-field cron evaluator for the automation builder —
// extracted from the builder god-file so it can be unit-tested (TESTING.md §2).
// No cron library ships to the renderer, so this covers exactly what the config
// pane needs: `*`, `?`, `*/n` steps, comma lists, `a-b` ranges, and the named
// day/month tokens a manifest may carry. Pure: value→value, UTC throughout.

const CRON_DOW: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const CRON_MON: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/** Does one cron field (with lists/ranges/steps/names) match a given value? */
export function cronFieldMatch(
  field: string,
  value: number,
  min: number,
  max: number,
  names: Record<string, number>,
): boolean {
  for (let part of field.split(',')) {
    part = part.trim();
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      step = parseInt(part.slice(slash + 1), 10) || 1;
      part = part.slice(0, slash);
    }
    let lo = min;
    let hi = max;
    if (part !== '*' && part !== '?' && part !== '') {
      const resolve = (t: string): number => {
        const named = names[t.trim().toUpperCase()];
        return named !== undefined ? named : parseInt(t, 10);
      };
      if (part.includes('-')) {
        const [a, b] = part.split('-');
        lo = resolve(a ?? '');
        hi = resolve(b ?? '');
      } else {
        lo = resolve(part);
        hi = lo;
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    if (value < lo || value > hi) continue;
    if ((value - lo) % step === 0) return true;
  }
  return false;
}

/**
 * Next `count` fire times for a 5-field cron, or `[]` if unparseable.
 *
 * Fields are matched against the **local** calendar, because that is what
 * actually fires the automation: the scheduler's matcher
 * (`packages/automation/src/fire/cron-match.ts`) reads `getHours()` /
 * `getDay()` off the host clock. This used to match in UTC while its only
 * consumer — `relativeRunLabel` — formatted the result with
 * `toLocaleTimeString`, so every preview was off by the viewer's UTC offset:
 * `0 19 * * 1-5` advertised "12:30 AM" on IST for a job that runs at 7pm.
 * Preview and scheduler have to read the expression the same way.
 */
export function cronNextRuns(expr: string, count: number, from: Date = new Date()): Date[] {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return [];
  const [minF, hourF, domF, monF, dowF] = f as [string, string, string, string, string];
  const out: Date[] = [];
  const d = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    from.getHours(),
    from.getMinutes() + 1,
  );
  const cap = 366 * 24 * 60; // step at most one year of minutes
  for (let i = 0; i < cap && out.length < count; i++) {
    const domStar = domF === '*' || domF === '?';
    const dowStar = dowF === '*' || dowF === '?';
    const domOk = cronFieldMatch(domF, d.getDate(), 1, 31, {});
    const dow = d.getDay();
    const dowOk =
      cronFieldMatch(dowF, dow, 0, 7, CRON_DOW) ||
      cronFieldMatch(dowF, dow === 0 ? 7 : dow, 0, 7, CRON_DOW);
    // Standard cron: when both day fields are restricted they OR;
    // when one is `*` the other governs.
    const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
    if (
      dayOk &&
      cronFieldMatch(minF, d.getMinutes(), 0, 59, {}) &&
      cronFieldMatch(hourF, d.getHours(), 0, 23, {}) &&
      cronFieldMatch(monF, d.getMonth() + 1, 1, 12, CRON_MON)
    ) {
      out.push(new Date(d));
    }
    // Wall-clock stepping, like the scheduler's own poll: across a DST shift
    // the local hour is what moves, and that is the field cron matches on.
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

/**
 * Best-effort plain-English gloss of a 5-field cron expression.
 *
 * Times are the gateway host's wall clock — the same basis the scheduler
 * matches on — so they carry no zone suffix. These glosses used to say "UTC",
 * which was doubly wrong: the job fires on local time, and the label sat next
 * to a next-run pill already formatted in local time.
 */
export function describeCron(expr: string): string {
  const t = expr.trim().replace(/\s+/g, ' ');
  const known: Record<string, string> = {
    '0 9 * * *': 'Every day at 09:00',
    '0 0 * * *': 'Every day at midnight',
    '0 * * * *': 'Every hour, on the hour',
    '*/30 * * * *': 'Every 30 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/5 * * * *': 'Every 5 minutes',
    '0 9 * * 1-5': 'Weekdays at 09:00',
    '0 9 * * MON-FRI': 'Weekdays at 09:00',
    '0 9 * * 1': 'Every Monday at 09:00',
  };
  if (known[t]) return known[t];
  const f = t.split(' ');
  const pad2 = (n: string): string => n.padStart(2, '0');
  if (f.length === 5) {
    if (
      /^\d+$/.test(f[0]!) &&
      /^\d+$/.test(f[1]!) &&
      f[2] === '*' &&
      f[3] === '*' &&
      f[4] === '*'
    ) {
      return `Every day at ${pad2(f[1]!)}:${pad2(f[0]!)}`;
    }
    if (f[0]!.startsWith('*/') && f.slice(1).every((x) => x === '*')) {
      return `Every ${f[0]!.slice(2)} minutes`;
    }
    if (/^\d+$/.test(f[0]!) && f.slice(1).every((x) => x === '*')) {
      return `Every hour at :${pad2(f[0]!)}`;
    }
  }
  return `Cron: ${t}`;
}
