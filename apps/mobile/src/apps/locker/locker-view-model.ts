// THE PHONE'S OWN TABLES — the derivations this seat needs that no other seat
// does. Anything a seat SHARES is imported: row recipe and window foot from
// `format.ts`, sentences from `view-copy.ts` / `route-copy.ts`. What stays here
// is (1) which designed state a screen is in, resolved once so nine surfaces
// cannot each pick a different notice, and (2) the copy for the one surface
// this seat cannot perform.
//
// Pure: no `react-native` import, so `locker-view-model.test.ts` asserts it
// directly.

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

// ─── 1 · Which state a screen is in ─────────────────────────────────────────

/**
 * `denied`, `parked` and `dayone` stay three values, never one emptiness: a
 * revoked grant has a receipt behind it, day one is an invitation, and the two
 * look nothing alike (STATES.md, rule 1).
 */
export type LockerScreenState =
  | "loading"
  | "denied"
  | "offline"
  | "pending"
  | "conflict"
  | "parked"
  | "dayone"
  | "reauth"
  | "ready";

export interface LockerStateInput {
  /** The read has not landed yet. Nothing is empty until a read has landed. */
  loaded: boolean;
  denied: boolean;
  online: boolean;
  /** Metadata writes still on this device — never a secret (writes.ts). */
  pending: number;
  /** A row carrying an unresolved edit from two devices. */
  conflicted: boolean;
  /** A purge asked for on a device that is not the owner's. */
  parked: boolean;
  /** A permit ran out with nothing revealed. */
  reauth: boolean;
  /** Rows in the window a landed read returned. */
  rows: number;
}

/**
 * Precedence order is the argument: a refusal outranks a delay, a delay
 * outranks an emptiness. A screen showing "nothing is kept here yet" over a
 * denied read would be describing a vault it never got to look at.
 */
export function lockerScreenState(input: LockerStateInput): LockerScreenState {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  if (input.reauth) return "reauth";
  if (input.conflicted) return "conflict";
  if (input.parked) return "parked";
  if (!input.online) return "offline";
  if (input.pending > 0) return "pending";
  if (input.rows === 0) return "dayone";
  return "ready";
}

/**
 * The items payload carries `truncated` and `window` and NO total, so the foot
 * may not state a denominator; `windowEndCopy` owns that wording.
 */
export function lockerWindowFoot(
  loaded: boolean,
  shown: number,
  truncated: boolean
): string | null {
  if (!loaded || shown === 0) return null;
  return windowEndCopy(shown, truncated);
}

/**
 * The multi-vault session's pending row carries its app in the LABEL
 * (`multi-vault-session.ts`: `${appId}: ${action}`) and nowhere else, so the
 * prefix is the only handle this seat has. Widening that row to carry `appId`
 * is a frame change and is not this app's to make.
 */
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

/**
 * Locker reads its rows through the gateway's query handlers rather than the
 * replica plane (docs/mobile-offline.md, "Locker is stricter"), so no Locker
 * row can carry the overlay stamps and the DEVICE-GLOBAL outbox is the only
 * honest source for this sentence. A status the overlay grammar has no rung for
 * is skipped, never coerced into one.
 */
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

// ─── 2 · The one surface whose door is on another seat ───────────────────────

export interface LockerSurfaceFact {
  key: string;
  value?: string;
  note?: string;
}

export interface LockerSurfaceCopy {
  title: string;
  lede: string;
  facts: readonly LockerSurfaceFact[];
  /** Where the act actually happens, from this seat. */
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

/**
 * Companion is the only surface without a door on this seat, so this takes no
 * key: a key argument would be a slot inviting a second description of an act
 * the phone can already perform.
 */
export function lockerFillCopy(): LockerSurfaceCopy {
  return FILL_SURFACE;
}
