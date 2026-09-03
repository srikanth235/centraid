import { pendingOverlayCopy } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlayStatus } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { windowEndCopy } from "@centraid/blueprints/apps/locker/format";
import {
  FILL_GET,
  FILL_GET_ROW,
  FILL_HEAD,
  FILL_LEDE,
  FILL_OFFERS,
  FILL_OFFERS_ROW,
  FILL_WHERE,
} from "@centraid/blueprints/apps/locker/route-copy";

export type LockerScreenState =
  | "loading"
  | "denied"
  | "offline"
  | "stale"
  | "pending"
  | "conflict"
  | "parked"
  | "dayone"
  | "reauth"
  | "ready";

export interface LockerStateInput {
  loaded: boolean;
  denied: boolean;
  online: boolean;
  pending: number;
  conflicted: boolean;
  parked: boolean;
  reauth: boolean;
  rows: number;
  stale: boolean;
}

export function lockerScreenState(input: LockerStateInput): LockerScreenState {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  if (input.reauth) return "reauth";
  if (input.conflicted) return "conflict";
  if (input.parked) return "parked";
  if (!input.online) return "offline";
  if (input.pending > 0) return "pending";
  if (input.stale) return "stale";
  if (input.rows === 0) return "dayone";
  return "ready";
}

export function lockerWindowFoot(
  loaded: boolean,
  shown: number,
  truncated: boolean
): string | null {
  if (!loaded || shown === 0) return null;
  return windowEndCopy(shown, truncated);
}

export function lockerPendingCount(
  pending: readonly { label: string }[]
): number {
  return pending.filter((change) => change.label.startsWith(APP_PREFIX)).length;
}

const APP_PREFIX = "locker:";

const OVERLAY_STATUSES: readonly PendingOverlayStatus[] = [
  "queued",
  "sending",
  "parked",
  "denied",
  "conflict",
  "failed",
  "expired",
  "cancelled",
];

export function lockerPendingLine(
  pending: readonly {
    id: string;
    label: string;
    status: string;
    reason?: string;
  }[]
): string | null {
  for (const change of pending) {
    if (!change.label.startsWith(APP_PREFIX)) continue;
    const status = OVERLAY_STATUSES.find((rung) => rung === change.status);
    if (!status) continue;
    return pendingOverlayCopy({
      key: change.id,
      status,
      action: change.label.slice(APP_PREFIX.length).trim(),
      ...(change.reason ? { reason: change.reason } : {}),
    });
  }
  return null;
}

export interface LockerSurfaceFact {
  key: string;
  value?: string;
  note?: string;
}

export interface LockerSurfaceCopy {
  title: string;
  lede: string;
  facts: readonly LockerSurfaceFact[];
  where: string;
}

const FILL_SURFACE: LockerSurfaceCopy = {
  title: FILL_HEAD,
  lede: FILL_LEDE,
  facts: [
    { key: FILL_OFFERS_ROW, note: FILL_OFFERS },
    { key: FILL_GET_ROW, note: FILL_GET },
  ],
  where: FILL_WHERE,
};

export function lockerFillCopy(): LockerSurfaceCopy {
  return FILL_SURFACE;
}
