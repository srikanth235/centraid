import {
  ribbonCollapsed,
  ribbonCollapsedBirthdays,
  shelfDue,
} from "./view-copy.ts";

export type LayerId = "bdays" | "due" | "hols";

export type LayerState = Readonly<Record<LayerId, boolean>>;

export const ALL_LAYERS_ON: LayerState = { bdays: true, due: true, hols: true };

export interface BirthdayFact {
  party_id: string;
  name: string;
  month: number;
  day: number;
  tier: "inner" | "outer";
}

export interface DueTask {
  task_id: string;
  title: string;
}

export interface DueFact {
  day: string;
  count: number;
  tasks?: readonly DueTask[];
}

export interface HolidayFact {
  day: string;
  name: string;
}

export interface DayContextData {
  birthdays: readonly BirthdayFact[];
  due: readonly DueFact[];
  holidays: readonly HolidayFact[];
  vaultDenied?: { code?: string; message?: string };
}

export const NO_DAY_CONTEXT: DayContextData = {
  birthdays: [],
  due: [],
  holidays: [],
};

export interface RibbonFact {
  kind: "birthday" | "holiday";
  id: string;
  text: string;
  inner?: boolean;
}

function monthDayOf(dayKey: string): string {
  return dayKey.slice(5, 10);
}

function padded(month: number, day: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function ribbonsFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): RibbonFact[] {
  const facts: RibbonFact[] = [];
  if (layers.bdays) {
    const target = monthDayOf(dayKey);
    for (const birthday of data.birthdays) {
      if (padded(birthday.month, birthday.day) !== target) continue;
      facts.push({
        kind: "birthday",
        id: birthday.party_id,
        text: birthday.name,
        ...(birthday.tier === "inner" ? { inner: true } : {}),
      });
    }
  }
  if (layers.hols) {
    for (const holiday of data.holidays) {
      if (holiday.day !== dayKey) continue;
      facts.push({ kind: "holiday", id: holiday.day, text: holiday.name });
    }
  }
  return facts;
}

export function ribbonLabel(facts: readonly RibbonFact[]): string {
  const first = facts[0];
  if (!first) return "";
  if (facts.length === 1) return first.text;
  const birthdays = facts.filter((fact) => fact.kind === "birthday").length;
  return birthdays === facts.length
    ? ribbonCollapsedBirthdays(birthdays)
    : ribbonCollapsed(facts.length);
}

export function dueCountFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): number {
  if (!layers.due) return 0;
  for (const fact of data.due) if (fact.day === dayKey) return fact.count;
  return 0;
}

export function shelfLabel(count: number): string {
  return shelfDue(count);
}

export function dueTasksFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): readonly DueTask[] {
  if (!layers.due) return [];
  for (const fact of data.due) if (fact.day === dayKey) return fact.tasks ?? [];
  return [];
}

export function hasAnyContext(data: DayContextData): boolean {
  return (
    data.birthdays.length > 0 || data.due.length > 0 || data.holidays.length > 0
  );
}
