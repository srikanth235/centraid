// THE PHONE'S OWN TABLES — the derivations this seat needs that no other seat
// does, and nothing else.
//
// Everything a seat SHARES is imported: the sign convention and every figure's
// tone are `format.ts`, the day headings and the window are `activity-model.ts`,
// the three Waiting sections are `contrib-model.ts`, the six divisions are
// `split-model.ts`, and every sentence is `view-copy.ts` / `tally-seat-copy.ts`.
// What is genuinely this seat's own is here:
//
//   1. WHICH DESIGNED STATE A SCREEN IS IN. Seven states plus Tally's own two
//      — All settled and Window end — resolved once so a dozen surfaces cannot
//      each decide differently which notice they are showing (STATES.md).
//   2. HOW THIS DEVICE'S OUTBOX BECOMES WAITING'S ROWS. `contrib-model.ts`
//      takes commons intents; this phone holds an intent OUTBOX, which is a
//      different shape carrying different facts, and the adapter that maps one
//      onto the other is this seat's and only this seat's.
//   3. WHICH EXPENSE THE MEMBER TAPPED. A row can arrive from the activity,
//      group or friend payload, so the lookup walks all three rather than
//      making every caller remember which list it came from.
//
// Pure: no `react-native` import, so `tally-view-model.test.ts` asserts it
// directly.

import { contribSections } from "@centraid/blueprints/apps/tally/contrib-model";
import type {
  ContribDoors,
  ContribSections,
  Intent,
} from "@centraid/blueprints/apps/tally/contrib-model";
import { allSettled } from "@centraid/blueprints/apps/tally/format";
import { windowEnd } from "@centraid/blueprints/apps/tally/view-copy";

import { windowFootNoTotal } from "./tally-seat-copy";

// ─── 1 · Which state a screen is in ─────────────────────────────────────────

/**
 * The designed states plus the two of Tally's own that a LIST-bearing surface
 * can be in. `ready` is the last answer and the commonest: there is nothing to
 * say, so nothing is said.
 *
 * `stale` is NOT among them (#922 E7). It was a verdict about how old a
 * gateway RPC's answer was; every figure on this seat is now derived on this
 * device from its own replica, so a landed read is exactly as current as the
 * device is. A replica that is BEHIND THE VAULT is a different fact, said once
 * by the frame — `offline` here, coverage on the status line — and it already
 * outranks in the order below.
 *
 * `denied` and `dayone` are deliberately two values and not one emptiness:
 * denied is a revoked grant with a receipt behind it, day one is an invitation,
 * and the two look nothing alike (STATES.md, rule 1).
 */
export type TallyScreenState =
  | "loading"
  | "denied"
  | "conflict"
  | "parked"
  | "offline"
  | "pending"
  | "dayone"
  | "settled"
  | "ready";

export interface TallyStateInput {
  /** The read has not landed yet. Nothing is empty until a read has landed. */
  loaded: boolean;
  denied: boolean;
  online: boolean;
  /** Writes still on this device — Tally records offline, so this is ordinary. */
  pending: number;
  /** A row carrying an unresolved edit from two devices. */
  conflicted: boolean;
  /** A steward-only act is waiting on somebody. */
  parked: boolean;
  /** Rows in the window a landed read returned. */
  rows: number;
  /**
   * Every net this surface derives, where it derives any. `undefined` is a
   * surface with no balance on it (Activity, Trash, Search): they can never be
   * All settled, and saying so with an empty array would claim they were.
   */
  nets?: readonly number[];
}

/**
 * ONE resolution, in precedence order, and the order is the argument:
 * a refusal outranks a delay, a delay outranks an emptiness, and an emptiness
 * outranks a level balance. A screen that said "everyone is level" over a
 * denied read would be describing a ledger it never got to look at.
 */
export function tallyScreenState(input: TallyStateInput): TallyScreenState {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  if (input.conflicted) return "conflict";
  if (input.parked) return "parked";
  if (!input.online) return "offline";
  if (input.pending > 0) return "pending";
  if (input.rows === 0) return "dayone";
  // ALL SETTLED IS NOT AN EMPTINESS. There are rows; every one of them is
  // level. It is stated, never celebrated (§6), and it comes last because a
  // queued write is a fact about the figures themselves.
  if (
    input.nets !== undefined &&
    input.nets.length > 0 &&
    allSettled(input.nets)
  )
    return "settled";
  return "ready";
}

/**
 * The window's foot, or nothing.
 *
 * §6's sentence is `60 of 194 · this is a window on the ledger, not all of it`,
 * and `view-copy.windowEnd` renders exactly that — but only where a TOTAL is
 * known. `queries/activity.ts`, `group.ts` and `friend.ts` return a bounded
 * list and no count of what lies behind it, so `total` is the length of what
 * arrived and the denominator would be a claim nobody checked. When the caller
 * knows a real total it passes one and the §6 line comes back verbatim; when
 * it does not, the honest variant says what is shown and that the window is a
 * window.
 */
export function tallyWindowFoot(
  loaded: boolean,
  shown: number,
  total: number | null
): string | null {
  if (!loaded || shown === 0) return null;
  return total === null ? windowFootNoTotal(shown) : windowEnd(shown, total);
}

/**
 * How many of the device's pending writes are Tally's.
 *
 * The multi-vault session's pending row carries its app in the LABEL
 * (`multi-vault-session.ts`: `${appId}: ${action}`) and nowhere else, so the
 * prefix is the only handle this seat has. Widening that row to carry `appId`
 * is a frame change and is not this app's to make; the parse is stated here,
 * once, rather than in each screen that wants the count.
 */
export const TALLY_PENDING_PREFIX = "tally:";

export function tallyPendingCount(
  pending: readonly { label: string }[]
): number {
  return pending.filter((change) =>
    change.label.startsWith(TALLY_PENDING_PREFIX)
  ).length;
}

export function tallyHasParked(
  pending: readonly { status: string; label: string }[]
): boolean {
  return pending.some(
    (change) =>
      change.label.startsWith(TALLY_PENDING_PREFIX) &&
      change.status === "parked"
  );
}

export function tallyHasConflict(
  pending: readonly { status: string; label: string }[]
): boolean {
  return pending.some(
    (change) =>
      change.label.startsWith(TALLY_PENDING_PREFIX) &&
      change.status === "conflict"
  );
}

/**
 * A wall clock for a sentence that names a moment — the gate's revocation time.
 *
 * The copy takes a time and puts it in a sentence; it does not decide what a
 * time LOOKS like, because that is a locale question and the web seat answers
 * it with the browser's own formatter. Hermes has `Intl`, but a notice is one
 * place the answer must be stable across a render, so the hour and minute are
 * read off the stamp directly and an unreadable stamp yields nothing rather
 * than `Invalid Date`.
 */
export function clockAt(iso: string): string | null {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return null;
  const at = new Date(stamp);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ─── 2 · This device's outbox, as Waiting's rows ────────────────────────────

/** One row of the phone's durable outbox, as `pendingChanges()` answers. */
export interface OutboxRow {
  id: string;
  status: string;
  label: string;
  reason?: string;
}

/** The action, recovered from the label the multi-vault session composes. A
 *  row whose label carries no action is still a row, and `commandLabel` has a
 *  word for it. */
export function outboxAction(label: string): string {
  const at = label.indexOf(":");
  return at < 0 ? "" : label.slice(at + 1).trim();
}

/**
 * The outbox, in the shape `contrib-model.ts` folds.
 *
 * EVERY ROW HERE IS THE MEMBER'S OWN, and that is a fact about this seat, not
 * a simplification: the phone's outbox holds the writes this device composed
 * and nothing else. `actorPartyId` is therefore `me` on every row, which is
 * what makes `contrib-model` file them under *in flight* and *ended* and never
 * under *Waiting on you* — a steward's inbox is the shell's Approvals surface,
 * and Waiting hands over to it rather than drawing a decision it cannot take.
 *
 * `createdAt` is empty because the outbox row carries no stamp; the sections
 * do not sort on it, and inventing one would be a figure nobody derived.
 */
export function outboxIntents(
  rows: readonly OutboxRow[],
  me: string | null
): Intent[] {
  return rows
    .filter((row) => row.label.startsWith(TALLY_PENDING_PREFIX))
    .map((row) => ({
      intentId: row.id,
      actorPartyId: me ?? "",
      command: outboxAction(row.label),
      input: {},
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      createdAt: "",
    }));
}

/**
 * WHICH DOORS THIS SEAT ACTUALLY HAS.
 *
 * `cancel`, `retry` and `discard` are the outbox's own verbs and the
 * multi-vault session exposes all three. `approvals` is the hand-over to the
 * shell's Approvals inbox, which this phone does have as a route.
 *
 * `decide` IS FALSE, and that is a fact about this transport rather than a
 * preference. The gateway grew a per-intent Approve/Decline door with the #872
 * backend (`core/protocol/routes.ts` `commonsIntentDecidePath`), but no mobile
 * client reaches it and nothing on this device reads another member's commons
 * intents at all — `session.pendingChanges()` answers with this phone's own
 * outbox. `contrib-model.ts` draws neither verb when this is false, with no
 * fallback standing in for one that cannot fire (protocol C1).
 */
export const TALLY_CONTRIB_DOORS: ContribDoors = {
  approvals: true,
  cancel: true,
  decide: false,
  discard: true,
  retry: true,
};

export function tallyWaiting(
  rows: readonly OutboxRow[],
  me: string | null
): ContribSections {
  return contribSections({
    doors: TALLY_CONTRIB_DOORS,
    intents: outboxIntents(rows, me),
    me: me ?? "",
    names: new Map<string, string>(),
  });
}

// ─── 3 · Finding the expense the member tapped ──────────────────────────────

/**
 * The decorated entry, out of whichever ledger the member tapped it from.
 *
 * NOT A SECOND READ. Every ledger payload this seat holds arrives already
 * decorated by the queries — splits, payers, lines, currency provenance, the
 * owner's stance, the pending overlay — so re-fetching one expense on its own
 * would be a second copy of facts already in hand, with the two free to
 * disagree by a render. `null` is honest: the member arrived by a deep link,
 * the payload it came from is not loaded, and the screen says so rather than
 * painting an empty expense.
 */
export function findEntry<T extends { expense_id: string }>(
  sources: readonly (readonly T[] | undefined | null)[],
  expenseId: string
): T | null {
  for (const source of sources) {
    const hit = source?.find((entry) => entry.expense_id === expenseId);
    if (hit) return hit;
  }
  return null;
}
