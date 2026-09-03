import { wallClockFields } from "../cron-timezone.js";

export function cronMatches(
  expr: string,
  date: Date,
  timeZone?: string
): boolean {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const wall = wallClockFields(date, timeZone);

  if (!matchField(minute, wall.minute, 0, 59)) return false;
  if (!matchField(hour, wall.hour, 0, 23)) return false;
  if (!matchField(month, wall.month, 1, 12)) return false;

  const domStar = isWildcard(dom);
  const dowStar = isWildcard(dow);
  const domMatch = matchField(dom, wall.day, 1, 31);
  const weekday = wall.weekday;
  const dowMatch =
    matchField(dow, weekday, 0, 7) ||
    (weekday === 0 && matchField(dow, 7, 0, 7));

  if (domStar && dowStar) return true;
  if (domStar) return dowMatch;
  if (dowStar) return domMatch;
  return domMatch || dowMatch;
}

function isWildcard(field: string): boolean {
  return field === "*" || field === "?";
}

function matchField(
  field: string,
  value: number,
  min: number,
  max: number
): boolean {
  if (isWildcard(field)) return true;
  return field.split(",").some((part) => partMatches(part, value, min, max));
}

function partMatches(
  part: string,
  value: number,
  min: number,
  max: number
): boolean {
  let base = part;
  let step = 1;
  const slash = part.indexOf("/");
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
  } else if (base.includes("-")) {
    const [a, b] = base.split("-");
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
