import { DAY_MS, MONTHS } from "../_shared/format-kit.ts";

export function daysSince(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY_MS));
}

export function daysSinceContact(
  person: { last_contacted_at?: string | null; created_at?: string | null },
  now = Date.now()
): number {
  return daysSince(person.last_contacted_at ?? person.created_at, now);
}

export function isOverdue(
  person: {
    cadence_days?: number | null;
    last_contacted_at?: string | null;
    created_at?: string | null;
  },
  now = Date.now()
): boolean {
  const cadence = Number(person.cadence_days ?? 0);
  if (!(cadence > 0)) return false;
  return daysSinceContact(person, now) > cadence;
}

export function agoLabel(days: number): string {
  if (days <= 0) return "Today";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function cadenceLabel(cadenceDays: number): string {
  const days = Math.max(0, Math.round(cadenceDays));
  if (days === 0) return "no cadence";
  return `every ${days} ${days === 1 ? "day" : "days"}`;
}

export function monthDayLabel(monthDay: string): string {
  const [month, day] = String(monthDay).split("-").map(Number);
  const name = month && month >= 1 && month <= 12 ? MONTHS[month - 1] : null;
  return name && day ? `${day} ${name}` : String(monthDay);
}

export function daysUntilMonthDay(monthDay: string, now = Date.now()): number {
  const [month, day] = String(monthDay).split("-").map(Number);
  if (!month || !day) return Number.MAX_SAFE_INTEGER;
  const today = new Date(now);
  const midnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  const occurrence = (year: number): Date => {
    const candidate = new Date(year, month - 1, day);
    return candidate.getMonth() === month - 1
      ? candidate
      : new Date(year, month, 0);
  };
  let next = occurrence(today.getFullYear());
  if (next < midnight) next = occurrence(today.getFullYear() + 1);
  return Math.round((next.getTime() - midnight.getTime()) / DAY_MS);
}

export function inDaysLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

export function whenLabel(iso: string | null | undefined, now = Date.now()) {
  const days = daysSince(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${agoLabel(days)} ago`;
}

export function cadenceLineLabel(
  cadenceDays: number,
  person: { last_contacted_at?: string | null; created_at?: string | null },
  now = Date.now()
): string {
  const days = Math.max(0, Math.round(cadenceDays));
  const since = daysSinceContact(person, now);
  const ago =
    since <= 0 ? "today" : since === 1 ? "yesterday" : `${agoLabel(since)} ago`;
  const every =
    days === 0 ? "No cadence" : `Every ${days} ${days === 1 ? "day" : "days"}`;
  return `${every} · last ${ago}`;
}

export function linkState(person: {
  linked?: boolean | null;
}): "linked" | "unlinked" | "unknown" {
  if (person.linked === true) return "linked";
  if (person.linked === false) return "unlinked";
  return "unknown";
}

export function toLinkCount(all: number, linked: number | null): number | null {
  return linked === null ? null : all - linked;
}

export function daysUntil(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - now) / DAY_MS));
}
