/**
 * Minute-resolution cron matcher for the in-process scheduler (issue #149).
 *
 * Salvaged from the deleted OS scheduler's field expansion. Supports the
 * numeric 5-field grammar the automation scaffolder emits and the manifest
 * validator accepts:
 *
 *   - `*` / `?`     → any value (`?` is treated as `*`)
 *   - `N`           → a single value
 *   - `A-B`         → an inclusive range
 *   - `A,B,C`       → a list (each part is itself any of these forms)
 *   - `*\/N`        → every Nth value across the field's full range
 *   - `A-B/N`       → every Nth value across a sub-range
 *
 * Standard Vixie day-of-month / day-of-week OR semantics: when both fields
 * are restricted, the date matches if EITHER matches; when one is `*`, only
 * the other constrains. `dow` accepts `0` and `7` for Sunday.
 *
 * Any field the matcher can't read (e.g. weekday names like `MON`) yields a
 * non-match for that field, so an unparseable expression simply never fires
 * rather than firing at the wrong time — fail-safe by construction.
 *
 * Matching is against the *local* wall clock, matching the prior OS-scheduler
 * (launchd/systemd) behavior.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  if (!matchField(minute, date.getMinutes(), 0, 59)) return false;
  if (!matchField(hour, date.getHours(), 0, 23)) return false;
  if (!matchField(month, date.getMonth() + 1, 1, 12)) return false;

  const domStar = isWildcard(dom);
  const dowStar = isWildcard(dow);
  const domMatch = matchField(dom, date.getDate(), 1, 31);
  // cron day-of-week: 0 and 7 both mean Sunday.
  const weekday = date.getDay();
  const dowMatch = matchField(dow, weekday, 0, 7) || (weekday === 0 && matchField(dow, 7, 0, 7));

  if (domStar && dowStar) return true;
  if (domStar) return dowMatch;
  if (dowStar) return domMatch;
  return domMatch || dowMatch;
}

function isWildcard(field: string): boolean {
  return field === '*' || field === '?';
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (isWildcard(field)) return true;
  return field.split(',').some((part) => partMatches(part, value, min, max));
}

function partMatches(part: string, value: number, min: number, max: number): boolean {
  let base = part;
  let step = 1;
  const slash = part.indexOf('/');
  if (slash !== -1) {
    step = Number(part.slice(slash + 1));
    base = part.slice(0, slash);
    if (!Number.isInteger(step) || step <= 0) return false;
  }

  let lo: number;
  let hi: number;
  if (isWildcard(base)) {
    lo = min;
    hi = max;
  } else if (base.includes('-')) {
    const [a, b] = base.split('-');
    lo = Number(a);
    hi = Number(b);
  } else {
    lo = Number(base);
    hi = lo;
  }

  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return false;
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}
