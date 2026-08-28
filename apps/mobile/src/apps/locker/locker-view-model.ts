// THE PHONE'S OWN TABLES — the derivations this seat needs that no other seat
// does, and nothing else.
//
// Everything a seat SHARES is imported: the row recipe is `format.ts`, the
// window's foot is `format.windowEndCopy`, the two registers of Review are
// `review-model.ts`, the field sets are `item-fields.ts`, every sentence is
// `view-copy.ts` / `route-copy.ts`. What is genuinely this seat's own is here:
//
//   1. WHICH DESIGNED STATE A SCREEN IS IN. Seven states plus Locker's own,
//      resolved once so nine surfaces cannot each decide differently which
//      notice they are showing (STATES.md's matrix).
//   2. WHAT THE ONE SURFACE THIS SEAT CANNOT PERFORM SAYS. Companion runs in
//      the browser extension, beside the page; the phone draws it as facts and
//      the sentence that says where the act happens, which is a DIFFERENT fact
//      from the one the desktop states and therefore different words
//      (docs/blueprint-seats.md, "search is not one behaviour"). Import and
//      Export used to be here for the same reason and are not any more — their
//      doors are reachable from this seat, so they are surfaces rather than
//      facts (`LockerImportView.tsx`, `LockerExportView.tsx`).
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
 * The seven designed states plus the two of Locker's own that a LIST-bearing
 * surface can be in. `ready` is the eighth answer and the commonest: there is
 * nothing to say, so nothing is said.
 *
 * `denied`, `refused` and `dayone` are deliberately three values and not one
 * emptiness: denied is a revoked grant with a receipt behind it, day one is an
 * invitation, and the two look nothing alike (STATES.md, rule 1).
 */
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
  /** The replica is behind the vault. */
  stale: boolean;
}

/**
 * ONE resolution, in precedence order, and the order is the argument:
 * a refusal outranks a delay, a delay outranks an emptiness, and an emptiness
 * outranks silence. A screen that showed "nothing is kept here yet" over a
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
  if (input.stale) return "stale";
  if (input.rows === 0) return "dayone";
  return "ready";
}

/**
 * The window's foot, or nothing.
 *
 * `windowEndCopy` is the shared derivation and it already carries the honest
 * variant: the items payload returns `truncated` and `window` and NO total, so
 * the sentence says what it is showing and that older items exist beyond it
 * rather than inventing README-Locker §6's denominator. The exact "300 of 312"
 * wording comes back the day the query serves a total, with no edit here.
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
 * How many of the device's pending writes are Locker's.
 *
 * The multi-vault session's pending row carries its app in the LABEL
 * (`multi-vault-session.ts`: `${appId}: ${action}`) and nowhere else, so the
 * prefix is the only handle this seat has. Widening that row to carry `appId`
 * is a frame change and is not this app's to make; the parse is stated here,
 * once, rather than in each screen that wants the count.
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
 * WHAT the outstanding metadata write is waiting for, in the shared overlay's
 * own words — including a steward's "waiting for …" (#880).
 *
 * `pendingNotice(n)` counts; this names. Locker reads its rows through the
 * gateway's own query handlers rather than the replica plane
 * (docs/mobile-offline.md, "Locker is stricter"), so no Locker row can carry
 * the overlay stamps and the DEVICE-GLOBAL outbox is the only honest source
 * for this sentence. A status the overlay grammar has no rung for is skipped
 * rather than coerced into one.
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
 * Companion, as facts plus the place the act happens.
 *
 * There is no `key` argument and that absence is the news: Import and Export
 * took one when all three surfaces were drawn the same way. Both perform on
 * this seat now, so Companion is the only member left — and a function that
 * still accepted a key would be a slot inviting a fourth description of an act
 * that has a door.
 */
export function lockerFillCopy(): LockerSurfaceCopy {
  return FILL_SURFACE;
}
