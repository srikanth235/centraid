// Custody arithmetic for the merged Vault surface (v11 "Where it lives").
//
// COPIES AND ENROLMENT ARE TWO NUMBERS, and conflating them is the defect this
// file exists to stop. A device that is enrolled can reach the vault; a device
// that keeps an offline copy holds a full replica of it on its own disk. Six
// devices enrolled and two holding a copy is the ordinary shape of a household,
// and a page that reported one number for both would tell a member their data
// survives the loss of a machine that never had it.
//
// The predicate is `rememberDevice`, because that is the bit Settings → Vault's
// "Keep an offline copy" switch actually writes (`settingsAccountData.ts` reads
// it back as `offlineCopy`). Every control's displayed value must be the value
// its action writes — so the page counts the same bit the switch sets, and not
// a checkpoint or a heuristic that would drift away from it.
//
// Pure: no React, no network, so every sentence the surface says about custody
// is testable on its own.

import type { GroupedDevice } from "./device-groups.js";

/** Does this device keep a full copy of the vault on its own disk? */
export function holdsReplica(device: GroupedDevice): boolean {
  return device.rememberDevice === true;
}

/**
 * The device row's replica clause — the SAME string on the row, in the drill-in
 * and in the custody line's arithmetic. One function, so a row can never say a
 * machine holds a copy while the line above it counts it as one that does not.
 */
export function replicaClause(device: GroupedDevice): string {
  return holdsReplica(device) ? "holds a full copy" : "reads from the gateway";
}

export interface CustodyCounts {
  /** Live hardware enrolled against this gateway. */
  devices: number;
  /** How many of them keep a full offline copy. */
  replicas: number;
}

/** Count the roster once, both ways. */
export function custodyCounts(
  devices: readonly GroupedDevice[]
): CustodyCounts {
  return {
    devices: devices.length,
    replicas: devices.filter(holdsReplica).length,
  };
}

/**
 * "41,208 records · 2 machines hold a full copy · 6 devices enrolled".
 *
 * The record count is OMITTED rather than guessed when the census has not
 * answered — an old gateway that cannot report one, or a read that failed
 * beside a roster that succeeded. One unrelated read failing must not make the
 * page state a number it does not have, and it must not make the page silent
 * about the two numbers it does.
 */
export function custodyLine(
  counts: CustodyCounts,
  records: number | null
): string {
  return [
    ...(records === null ? [] : [`${records.toLocaleString()} records`]),
    `${counts.replicas.toLocaleString()} ${counts.replicas === 1 ? "machine holds" : "machines hold"} a full copy`,
    `${counts.devices.toLocaleString()} device${counts.devices === 1 ? "" : "s"} enrolled`,
  ].join(" · ");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A BARE age, in the singular forms a sentence can carry: "just now", "an hour
 * ago", "2 days ago". The caller decides whether "seen" precedes it.
 *
 * It is not the running counter `formatDuration` gives ("1h 04m ago"). A
 * counter is right for uptime, where the seconds are the point; on a roster it
 * is a number that changes every second to say something a member reads once,
 * and it spends a laptop's battery being wrong more precisely. Below a minute
 * it says so in words rather than counting.
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
