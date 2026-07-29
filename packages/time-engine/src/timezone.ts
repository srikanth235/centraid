export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export interface ResolvedWallTime {
  instant: string;
  overlap: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, created);
  return created;
}

export function isIanaTimeZone(value: string): boolean {
  try {
    formatter(value).format(0);
    return value.trim().length > 0;
  } catch {
    return false;
  }
}

export function zonedParts(
  instant: string | number | Date,
  timeZone: string
): WallTime {
  const date = instant instanceof Date ? instant : new Date(instant);
  const values = new Map(
    formatter(timeZone)
      .formatToParts(date)
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
    millisecond: date.getUTCMilliseconds(),
  };
}

export function wallEpoch(value: WallTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond
  );
}

function sameWall(left: WallTime, right: WallTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function offsetAt(instantMs: number, timeZone: string): number {
  return wallEpoch(zonedParts(instantMs, timeZone)) - instantMs;
}

/**
 * Resolve a civil clock value into an instant. A gap returns null. An overlap
 * resolves to the earlier instant and is marked so callers can explain it.
 */
export function resolveWallTime(
  value: WallTime,
  timeZone: string
): ResolvedWallTime | null {
  if (!isIanaTimeZone(timeZone)) return null;
  const naive = wallEpoch(value);
  const offsets = new Set([
    offsetAt(naive - 86_400_000, timeZone),
    offsetAt(naive, timeZone),
    offsetAt(naive + 86_400_000, timeZone),
  ]);
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => sameWall(zonedParts(candidate, timeZone), value))
    .sort((left, right) => left - right);
  const first = candidates[0];
  if (first === undefined) return null;
  return {
    instant: new Date(first).toISOString(),
    overlap: candidates.length > 1,
  };
}

const WALL_ISO =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<millisecond>\d{1,3}))?)?)?/u;

export function parseWallIso(value: string): WallTime | null {
  const match = WALL_ISO.exec(value);
  if (!match?.groups) return null;
  const result = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
    hour: Number(match.groups.hour ?? 0),
    minute: Number(match.groups.minute ?? 0),
    second: Number(match.groups.second ?? 0),
    millisecond: Number((match.groups.millisecond ?? "0").padEnd(3, "0")),
  };
  const roundTrip = new Date(wallEpoch(result));
  if (
    roundTrip.getUTCFullYear() !== result.year ||
    roundTrip.getUTCMonth() + 1 !== result.month ||
    roundTrip.getUTCDate() !== result.day
  ) {
    return null;
  }
  return result;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function wallIso(value: WallTime, includeTime = true): string {
  const date = `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}`;
  if (!includeTime) return date;
  const milliseconds =
    value.millisecond > 0 ? `.${pad(value.millisecond, 3)}` : "";
  return `${date}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}${milliseconds}`;
}

export function addWallDays(value: WallTime, days: number): WallTime {
  const date = new Date(wallEpoch(value));
  date.setUTCDate(date.getUTCDate() + days);
  return utcParts(date);
}

export function addWallMonths(value: WallTime, months: number): WallTime {
  const date = new Date(wallEpoch(value));
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return utcParts(date);
}

export function wallWeekday(value: WallTime): number {
  return new Date(wallEpoch(value)).getUTCDay();
}

function utcParts(date: Date): WallTime {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}
