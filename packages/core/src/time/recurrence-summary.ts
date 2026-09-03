import { parseRrule } from "./rrule-support.js";
import type { ParsedRrule } from "./rrule-support.js";

const DAY_NAMES = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
} as const;

const UNIT_LABELS: Record<ParsedRrule["freq"], string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function joinDays(days: readonly (keyof typeof DAY_NAMES)[]): string {
  const names = days.map((day) => DAY_NAMES[day]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function weekdays(rule: ParsedRrule): readonly (keyof typeof DAY_NAMES)[] {
  return rule.byDay ?? [];
}

function cadence(rule: ParsedRrule): string {
  const days = weekdays(rule);
  const unit = UNIT_LABELS[rule.freq];
  if (rule.interval === 1) {
    if (days.length > 0) return `Every ${joinDays(days)}`;
    if (rule.freq === "DAILY") return "Daily";
    if (rule.freq === "WEEKLY") return "Weekly";
    return `Every ${unit}`;
  }
  const every =
    rule.interval === 2
      ? `Every other ${unit}`
      : `Every ${rule.interval} ${unit}s`;
  if (days.length === 0) return every;
  if (rule.interval === 2 && days.length === 1)
    return `Every other ${joinDays(days)}`;
  return `${every} on ${joinDays(days)}`;
}

function untilLabel(until: string): string | null {
  const match =
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})/u.exec(until) ??
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u.exec(until);
  if (!match?.groups) return null;
  const month = Number(match.groups.month);
  if (month < 1 || month > 12) return null;
  return `${MONTH_NAMES[month - 1]} ${Number(match.groups.day)}, ${Number(match.groups.year)}`;
}

function ending(rule: ParsedRrule): string {
  if (rule.count !== undefined)
    return rule.count === 1 ? " · once" : ` · ${rule.count} times`;
  if (rule.until === undefined) return "";
  const label = untilLabel(rule.until);
  return label ? ` · until ${label}` : "";
}

export function describeRecurrence(value: string): string | null {
  const rule = parseRrule(value);
  if (!rule) return null;
  return `${cadence(rule)}${ending(rule)}`;
}
