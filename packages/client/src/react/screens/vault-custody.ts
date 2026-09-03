import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import type { GroupedDevice } from "./device-groups.js";

export function holdsReplica(device: GroupedDevice): boolean {
  return device.rememberDevice === true;
}

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
