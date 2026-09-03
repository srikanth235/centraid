import { matchesCheck } from "./format.ts";
import {
  CHECK_LABEL,
  CHECK_WHY,
  UNRUNNABLE_CHECKS,
  UNSERVED_WHY,
} from "./route-copy.ts";
import type { CheckKey, LockerRow } from "./types.ts";

export interface VerdictRow {
  key: CheckKey;
  label: string;
  why: string;
  count: number;
  tone: "net" | "seam";
  items: LockerRow[];
}

export interface UnrunnableRow {
  key: string;
  label: string;
  why: string;
}

export interface ServedFields {
  address: boolean;
  expiry: boolean;
  age: boolean;
}

export function servedFields(rows: readonly LockerRow[]): ServedFields {
  return {
    address: rows.some((row) => "url" in row),
    expiry: rows.some((row) => "expiry" in row),
    age: rows.some((row) => "password_set_at" in row),
  };
}

function answerable(key: CheckKey, served: ServedFields): boolean {
  if (key === "http") return served.address;
  if (key === "expiring") return served.expiry;
  if (key === "age") return served.age;
  return true;
}

const CHECK_ORDER: readonly CheckKey[] = [
  "compromised",
  "weak",
  "reused",
  "http",
  "expiring",
  "age",
];

export interface ReviewRegister {
  attention: VerdictRow[];
  unrunnable: UnrunnableRow[];
  items: LockerRow[];
  verdicts: number;
  ran: CheckKey[];
  allClear: boolean;
}

export function reviewRegister(
  rows: readonly LockerRow[],
  now: number = Date.now()
): ReviewRegister {
  const served = servedFields(rows);
  const attention: VerdictRow[] = [];
  const unrunnable: UnrunnableRow[] = [];
  const ran: CheckKey[] = [];
  for (const key of CHECK_ORDER) {
    if (!answerable(key, served)) {
      unrunnable.push({
        key,
        label: CHECK_LABEL[key] ?? key,
        why: UNSERVED_WHY[key] ?? CHECK_WHY[key] ?? "",
      });
      continue;
    }
    ran.push(key);
    const held = rows.filter((row) => matchesCheck(row, key, now));
    if (held.length === 0) continue;
    attention.push({
      key,
      label: CHECK_LABEL[key] ?? key,
      why: CHECK_WHY[key] ?? "",
      count: held.length,
      tone: key === "compromised" ? "net" : "seam",
      items: held,
    });
  }
  unrunnable.push(...UNRUNNABLE_CHECKS);
  const seen = new Set<string>();
  const items: LockerRow[] = [];
  for (const verdict of attention) {
    for (const row of verdict.items) {
      if (seen.has(row.item_id)) continue;
      seen.add(row.item_id);
      items.push(row);
    }
  }
  return {
    attention,
    unrunnable,
    items,
    verdicts: attention.reduce((total, row) => total + row.count, 0),
    ran,
    allClear: attention.length === 0,
  };
}
