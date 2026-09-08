// Custody arithmetic (v11 "Where it lives"). COPIES AND ENROLMENT ARE TWO
// NUMBERS. Enrolled = can reach; replica = full copy on disk. Conflating
// them tells a member their data survives a machine that never had it.
// Predicate is `rememberDevice` — the bit the "Keep an offline copy" switch
// writes (`offlineCopy` in `settingsAccountData.ts`).

import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import type { GroupedDevice } from "./device-groups.js";

export function holdsReplica(device: GroupedDevice): boolean {
  return device.rememberDevice === true;
}

/** Same string on the row, the drill-in, and the custody line. */
export function replicaClause(device: GroupedDevice): string {
  return holdsReplica(device) ? "holds a full copy" : "reads from the gateway";
}

export interface CustodyCounts {
  devices: number;
  replicas: number;
}

export function custodyCounts(
  devices: readonly GroupedDevice[]
): CustodyCounts {
  return {
    devices: devices.length,
    replicas: devices.filter(holdsReplica).length,
  };
}

/**
 * THE RECORD COUNT IS GONE; THE WATERMARK TAKES ITS PLACE (#996, R8).
 *
 * The line used to open with "41,208 records", derived from a census probe
 * over a shape. Two things were wrong with it. It dies with census in wave 5,
 * and — the reason it is not simply being re-sourced — it answered a question
 * nobody was asking. Under R1 every enrolled seat holds the whole vault, so
 * "how many records" is the same number everywhere and carries no information
 * about THIS machine. What a member wants to know about a copy is whether it
 * is current, which is the seat watermark.
 *
 * `undefined` still omits the clause rather than guessing: a seat that has not
 * reported must not cost the page the two numbers the roster does know.
 */
export function custodyLine(
  counts: CustodyCounts,
  watermark: string | undefined
): string {
  return [
    ...(watermark === undefined ? [] : [watermark]),
    `${counts.replicas.toLocaleString()} ${counts.replicas === 1 ? "machine holds" : "machines hold"} a full copy`,
    `${counts.devices.toLocaleString()} device${counts.devices === 1 ? "" : "s"} enrolled`,
  ].join(" · ");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Bare age for a roster ("just now", "an hour ago"), not `formatDuration`'s
 * running counter. Seconds are the point for uptime; here they drain battery
 * to be wrong more precisely.
 */
export function seenAge(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ms = Math.max(0, now - at);
  if (ms < MINUTE_MS) return "just now";
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min ago`;
  if (ms < 2 * HOUR_MS) return "an hour ago";
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)} hours ago`;
  if (ms < 2 * DAY_MS) return "yesterday";
  return `${Math.round(ms / DAY_MS)} days ago`;
}
