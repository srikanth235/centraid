// Minimal, self-contained 5-field cron evaluator for the automation builder —
// extracted from the builder god-file so it can be unit-tested (TESTING.md §2).
// No cron library ships to the renderer, so this covers exactly what the config
// pane needs: `*`, `?`, `*/n` steps, comma lists, `a-b` ranges, and the named
// day/month tokens a manifest may carry. Pure: value→value.
//
// Zone model (issue #570): optional IANA `timeZone` matches the engine's
// resolved zone (trigger `tz` → gateway default → host-local). Absent zone
// keeps host-local Date getters so preview stays aligned with #569.

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

const WEEKDAY_SHORT: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** True when `name` is a non-empty IANA zone known to this runtime's `Intl`. */
export function isValidIanaTimeZone(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the zone a cron schedule should match in.
 * Per-trigger → gateway default → host-local (`undefined`).
 */
export function resolveCronTimezone(
  triggerTz?: string | null,
  gatewayDefaultTz?: string | null
): string | undefined {
  for (const candidate of [triggerTz, gatewayDefaultTz]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (isValidIanaTimeZone(trimmed)) return trimmed;
  }
  return undefined;
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function wallClockFields(date: Date, timeZone?: string): WallClock {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour,
    minute: Number(pick("minute")),
    weekday: WEEKDAY_SHORT[pick("weekday")] ?? 0,
  };
}

/** Does one cron field (with lists/ranges/steps/names) match a given value? */
export function cronFieldMatch(
  field: string,
  value: number,
  min: number,
  max: number,
  names: Record<string, number>
): boolean {
  for (let part of field.split(",")) {
    part = part.trim();
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      step = Math.trunc(Number(part.slice(slash + 1))) || 1;
      part = part.slice(0, slash);
    }
    let lo = min;
    let hi = max;
    if (part !== "*" && part !== "?" && part !== "") {
      const resolve = (t: string): number => {
        const named = names[t.trim().toUpperCase()];
        return named === undefined ? Math.trunc(Number(t)) : named;
      };
      if (part.includes("-")) {
        const [a, b] = part.split("-");
        lo = resolve(a ?? "");
        hi = resolve(b ?? "");
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

function fieldsMatch(
  minF: string,
  hourF: string,
  domF: string,
  monF: string,
  dowF: string,
  wall: WallClock
): boolean {
  const domStar = domF === "*" || domF === "?";
  const dowStar = dowF === "*" || dowF === "?";
  const domOk = cronFieldMatch(domF, wall.day, 1, 31, {});
  const dow = wall.weekday;
  const dowOk =
    cronFieldMatch(dowF, dow, 0, 7, CRON_DOW) ||
    cronFieldMatch(dowF, dow === 0 ? 7 : dow, 0, 7, CRON_DOW);
  const dayOk =
    domStar && dowStar
      ? true
      : domStar
        ? dowOk
        : dowStar
          ? domOk
          : domOk || dowOk;
  return (
    dayOk &&
    cronFieldMatch(minF, wall.minute, 0, 59, {}) &&
    cronFieldMatch(hourF, wall.hour, 0, 23, {}) &&
    cronFieldMatch(monF, wall.month, 1, 12, CRON_MON)
  );
}

/**
 * Next `count` fire times for a 5-field cron, or `[]` if unparseable.
 *
 * When `timeZone` is set, fields match that zone's wall clock and stepping is
 * absolute-minute (correct across DST for a stored IANA zone). When omitted,
 * fields match the **local** calendar via Date getters and wall-clock
 * `setMinutes` stepping — the same basis as the scheduler without a zone.
 */
export function cronNextRuns(
  expr: string,
  count: number,
  from: Date = new Date(),
  timeZone?: string
): Date[] {
  const f = expr.trim().split(/\s+/u);
  if (f.length !== 5) return [];
  const [minF, hourF, domF, monF, dowF] = f as [
    string,
    string,
    string,
    string,
    string,
  ];
  const out: Date[] = [];
  const cap = 366 * 24 * 60; // step at most one year of minutes

  if (timeZone) {
    let ms = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < cap && out.length < count; i++) {
      const d = new Date(ms);
      if (
        fieldsMatch(minF, hourF, domF, monF, dowF, wallClockFields(d, timeZone))
      ) {
        out.push(d);
      }
      ms += 60_000;
    }
    return out;
  }

  const d = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    from.getHours(),
    from.getMinutes() + 1
  );
  for (let i = 0; i < cap && out.length < count; i++) {
    if (
      fieldsMatch(minF, hourF, domF, monF, dowF, {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        weekday: d.getDay(),
      })
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
 * Times are wall clock in the resolved schedule zone when `timeZone` is set;
 * otherwise the gateway host's wall clock. An explicit zone is named in the
 * gloss when provided so the preview does not look local when it is not.
 */
export function describeCron(expr: string, timeZone?: string): string {
  const t = expr.trim().replace(/\s+/gu, " ");
  const zoneSuffix = timeZone ? ` (${shortTimeZoneName(timeZone)})` : "";
  const known: Record<string, string> = {
    "0 9 * * *": `Every day at 09:00${zoneSuffix}`,
    "0 0 * * *": `Every day at midnight${zoneSuffix}`,
    "0 * * * *": "Every hour, on the hour",
    "*/30 * * * *": "Every 30 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/5 * * * *": "Every 5 minutes",
    "0 9 * * 1-5": `Weekdays at 09:00${zoneSuffix}`,
    "0 9 * * MON-FRI": `Weekdays at 09:00${zoneSuffix}`,
    "0 9 * * 1": `Every Monday at 09:00${zoneSuffix}`,
  };
  if (known[t]) return known[t];
  const f = t.split(" ");
  const pad2 = (n: string): string => n.padStart(2, "0");
  if (f.length === 5) {
    if (
      /^\d+$/u.test(f[0]!) &&
      /^\d+$/u.test(f[1]!) &&
      f[2] === "*" &&
      f[3] === "*" &&
      f[4] === "*"
    ) {
      return `Every day at ${pad2(f[1]!)}:${pad2(f[0]!)}${zoneSuffix}`;
    }
    if (f[0]!.startsWith("*/") && f.slice(1).every((x) => x === "*")) {
      return `Every ${f[0]!.slice(2)} minutes`;
    }
    if (/^\d+$/u.test(f[0]!) && f.slice(1).every((x) => x === "*")) {
      return `Every hour at :${pad2(f[0]!)}`;
    }
  }
  return `Cron: ${t}${zoneSuffix}`;
}

/** Short zone label (`IST`, `EDT`, `America/New_York` fallback). */
export function shortTimeZoneName(
  timeZone: string,
  at: Date = new Date()
): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name && name !== timeZone) return name;
  } catch {
    // fall through
  }
  // Prefer the city tail of an IANA name over the full path.
  const slash = timeZone.lastIndexOf("/");
  return slash >= 0 ? timeZone.slice(slash + 1).replace(/_/gu, " ") : timeZone;
}

/**
 * Next-run pill label in the schedule's zone. When the schedule zone differs
 * from the viewer's zone, appends a short zone name so "7:00 PM" is not
 * misread as local.
 */
export function cronRunLabel(
  d: Date,
  opts?: {
    timeZone?: string;
    viewerTimeZone?: string;
    now?: Date;
  }
): string {
  const scheduleTz = opts?.timeZone;
  const viewerTz = opts?.viewerTimeZone;
  const now = opts?.now ?? new Date();
  const formatOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(scheduleTz ? { timeZone: scheduleTz } : {}),
  };
  const time = d.toLocaleTimeString(undefined, formatOpts);

  const dayStart = (x: Date, tz?: string): number => {
    if (!tz) {
      return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    }
    const w = wallClockFields(x, tz);
    // Approximate day identity in zone via UTC components of a synthetic date.
    return Date.UTC(w.year, w.month - 1, w.day);
  };
  const dayDiff = Math.round(
    (dayStart(d, scheduleTz) - dayStart(now, scheduleTz)) / 86_400_000
  );
  const day =
    dayDiff === 0
      ? "Today"
      : dayDiff === 1
        ? "Tomorrow"
        : dayDiff > 1 && dayDiff < 7
          ? d.toLocaleDateString(undefined, {
              weekday: "short",
              ...(scheduleTz ? { timeZone: scheduleTz } : {}),
            })
          : d.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              ...(scheduleTz ? { timeZone: scheduleTz } : {}),
            });

  const base = `${day}, ${time}`;
  if (!scheduleTz) return base;
  const viewer = viewerTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!viewer || viewer === scheduleTz) return base;
  return `${base} ${shortTimeZoneName(scheduleTz, d)}`;
}
