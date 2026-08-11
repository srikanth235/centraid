import {
  createPendingOverlayModel,
  pendingReasonCopy,
} from "../_shared/pending-overlay.ts";
import type { PendingRowState } from "../_shared/pending-overlay.ts";
import type { WriteTarget } from "../_shared/write-target.ts";
// Outcome narration + the write trampoline (shared pattern across apps). No
// domain (asset/album) state lives here — it's generic plumbing, which is
// exactly why every action module and every component that needs to fire a
// command imports it directly instead of threading it through props.
//
// The pending-write overlay (issue #738): one model, created once, that
// `act()` wraps every write through — batch loops included, since each call
// mints its own intent id. An action absent from pending-projection.ts
// projects nothing, so this is a no-op for the app's many undeclared writes.
//
// MULTI-SCOPE (issue #599). Mounted over N scopes, a write has to say WHICH
// one, and there are exactly two ways to know:
//
//  * A write ABOUT an existing asset goes to the scope that asset is shown
//    from (`asset.scope_id`) — favoriting a photo in a shared audience must
//    edit it there, not some copy the member happens to own. Those callers
//    pass `scope` themselves.
//  * A write that CREATES something (an upload, a new album) goes wherever
//    `resolveWriteTarget` (apps/_shared/write-target.ts) says the current chip
//    selection puts new things. Callers ask `writeTarget()` for that, and when
//    it answers disabled they disable the control and show `reason` rather than
//    firing a write they already know will be refused.
//
// The resolver is registered once by app-root.tsx (which owns the chip
// selection); before then, and on any single-scope host, it answers with the
// ambient scope — the empty id every scope-addressed transport reads as "the
// one scope there is".
import { outcomeMessage } from "./kit.ts";
import { photosPendingProjection } from "./pending-projection.ts";

// Discarding an attention row also clears its DURABLE record through the
// engine's one port — a row that returns on the next reload was never really
// discarded. The clear is fire-and-forget by contract, so the failure is
// narrated on the status line rather than swallowed.
const pendingModel = createPendingOverlayModel(photosPendingProjection, {
  dismissDurable: (intentId) => {
    const forget = window.centraid.dismissAttentionWrite;
    if (!forget) return;
    void forget({ intentId }).catch(() =>
      notice("That change is gone from this view but may return on reload.")
    );
  },
});

// No `pendingByRowId()` export: Tile.tsx's four overlay slots (selection,
// vault, kind, state) are an explicit design budget ("NOT a fifth slot —
// §4.4 says four, and means it"), so this pass declares the projections and
// wires every write through the model — the composed read already carries a
// pending favorite/trash optimistically — without adding chip decoration no
// surface here has room for.
//
// That budget is also why a REFUSED write has no row of its own here (issue
// #738). Every other app re-shows it in a panel; Photos has exactly one place
// to say anything — the frame's status line (§3, §14: no toast, no badge, no
// second line) — so that is where a refusal is announced, with Discard as its
// inline action. Retry is not a button because it does not need to be: every
// declared Photos write is a one-tap record toggle (favorite, archive, trash,
// restore) whose control is still right there on the tile, so "do it again"
// is the same gesture as the first time. Discard is the only answer with no
// other route, and it is the one the durable journal needs.

/** The intent ids the status line has already announced — so `restorePending`
 *  (mount AND every refresh) only speaks when the set actually changes, and
 *  never stomps an unrelated outcome sentence on every repaint. */
let announcedAttention = "";

function announceAttention(): void {
  const rows = pendingModel.attention();
  const key = rows.map((row) => row.intentId).join(",");
  if (key === announcedAttention) return;
  announcedAttention = key;
  const row = rows[0];
  if (!row) return;
  const reason = pendingReasonCopy(
    row.status,
    row.reason ? { reason: row.reason } : {}
  );
  const more = rows.length > 1 ? ` (${rows.length - 1} more)` : "";
  statusSink?.({
    text: `That change was not saved. ${reason}${more}`,
    action: {
      label: "Discard",
      run: () => {
        pendingModel.dismiss(row.intentId);
        announcedAttention = "";
        if (pendingModel.attention().length === 0) notice("");
        else announceAttention();
      },
    },
  });
}

/** The reload path (issue #738): rebuild from local truth alone. TWO durable
 *  sources, because a settled write leaves the outbox — the outbox for what
 *  is still in flight, the attention journal for what came back
 *  denied/conflicted/failed. Feature-detected — the visual-harness mock and
 *  older hosts lack both. Unlike the per-app `logic.ts` factories, this
 *  module has no render hook of its own — the caller (app-root.tsx)
 *  re-renders after awaiting this. */
export async function restorePending(): Promise<void> {
  const [durable, attention] = await Promise.all([
    window.centraid.pendingWrites?.() ?? [],
    window.centraid.attentionWrites?.() ?? [],
  ]);
  pendingModel.restore(durable);
  pendingModel.restoreAttention(attention);
  announceAttention();
}

/** The writes that settled without executing and still need an answer. The
 *  status line shows one at a time; this is the whole set, for tests and for
 *  any future surface that earns the room to list them. */
export function attentionRows(): PendingRowState[] {
  return pendingModel.attention();
}

/** Fold one change-feed event into the pending model; true when it moved. */
export function applyPendingChange(detail: CentraidChangeDetail): boolean {
  return pendingModel.applyChangeDetail(detail);
}

/**
 * Which write is being placed. `new` follows the chip selection (an upload
 * lands in the audience the member is looking at); `own` is for the surfaces
 * that are the member's own by construction — albums, tags and places are
 * per-scope collections this app only ever authors in the member's own space.
 */
export type WriteTargetKind = "new" | "own";

/** Where new things land while nothing better is known: the ambient scope. */
const AMBIENT_TARGET: WriteTarget = {
  disabled: false,
  scopeId: "",
  label: "Library",
};

let resolveTarget: (kind: WriteTargetKind) => WriteTarget = () =>
  AMBIENT_TARGET;

/** app-root.tsx installs the chip-aware resolver once, at mount. */
export function setWriteTargetResolver(
  fn: (kind: WriteTargetKind) => WriteTarget
): void {
  resolveTarget = fn;
}

/** Where a creating write would land right now, or why it cannot land at all. */
export function writeTarget(kind: WriteTargetKind = "new"): WriteTarget {
  return resolveTarget(kind);
}

/**
 * Where narration goes (v4 handoff §3, §14). The ONE status line belongs to
 * the FRAME, and every write outcome announces itself there — briefly, with
 * **Undo** where undo is possible. There is no second line, no badge, no
 * spinner and no red dot, so a later note replaces the earlier one in place.
 *
 * The sink is installed once by app-root.tsx, which holds the frame handle.
 * Until it is — and on any host that mounts this app without a frame — the
 * calls below are no-ops rather than a banner the app drew for itself: the
 * `#noticeBanner` this used to write to retired with the app's own chrome.
 */
export interface StatusNote {
  text: string;
  undo?: () => void;
  /**
   * A NAMED inline action, for the sentences that are not undos. Issue #738's
   * refused-write announcement is the first: its one answer is "Discard", and
   * labelling that button "Undo" would say the opposite of what it does.
   */
  action?: { label: string; run: () => void };
  /**
   * Determinate progress with exact counts (§14) — `148 / 214`, never a
   * spinner. A long local operation (an import, a batch write) says how far it
   * has got on the SAME status line rather than growing a second surface, and
   * app-root.tsx passes this straight through to the frame's meter.
   */
  progress?: { done: number; total: number };
}

let statusSink: ((note: StatusNote | null) => void) | null = null;

/** app-root.tsx installs the frame-backed sink once, at mount. */
export function setStatusSink(
  fn: ((note: StatusNote | null) => void) | null
): void {
  statusSink = fn;
  // A fresh mount has a fresh (empty) status line, and this module's model
  // outlives it. Forgetting what was announced is what lets the refused write
  // this route still holds be said again on the way back in (issue #738) —
  // otherwise a member who navigated away would never hear about it twice.
  if (fn) announcedAttention = "";
}

/**
 * Say one thing on the status line, or take it back down with `""`.
 *
 * `progress` is the determinate meter (§14): a caller that knows how many of
 * how many it has done says so, and the frame draws the bar. A caller that
 * does not know says nothing rather than animating an indeterminate one.
 */
export function notice(
  text: string,
  undo?: () => void,
  progress?: { done: number; total: number }
): void {
  statusSink?.(
    text
      ? { text, ...(undo ? { undo } : {}), ...(progress ? { progress } : {}) }
      : null
  );
}

export function narrate(
  outcome: VaultOutcome | null | undefined,
  noteEl?: HTMLElement | null
): boolean {
  if (outcome?.status === "executed") {
    notice("");
    if (noteEl) noteEl.textContent = "";
    return true;
  }
  const msg = outcomeMessage(outcome);
  if (msg != null) {
    notice(msg);
    if (noteEl) noteEl.textContent = msg;
  }
  return false;
}

/**
 * Fire one typed command. `scope` names the mounted scope it lands in; an empty
 * or absent scope addresses the ambient one, which is what a single-scope mount
 * wants and what every pre-#599 call site keeps doing unchanged.
 */
/** The declared writes that change an asset row that already exists — the
 *  ones a second device can race. Photos declares no creating write at all
 *  (an upload is a byte path, deliberately unprojected). */
const VERSIONED_ACTIONS = new Set(["update-asset", "delete-asset", "restore"]);

/**
 * The optimistic-concurrency precondition for one write (issue #738 P2): the
 * version of the `media.media_asset` row this device composed the change
 * against, read from the local replica — in the SAME scope the write lands
 * in, since the asset shown from a shared audience is that audience's row,
 * not a copy of it. Without this a conflict cannot even occur, so it is what
 * makes a `conflict` outcome, and its expected-vs-actual detail, reachable.
 *
 * Empty is the honest answer for a host with no version surface and for a row
 * this scope cannot address by an exposed key; neither one is faked.
 */
async function baseVersionsFor(
  action: string,
  input: Record<string, unknown>,
  scope?: string | null
): Promise<CentraidBaseVersion[]> {
  const assetId = input.asset_id;
  if (!VERSIONED_ACTIONS.has(action) || typeof assetId !== "string") return [];
  const readVersion = window.centraid.rowVersion;
  if (!readVersion) return [];
  const version = await readVersion({
    entity: "media.media_asset",
    rowId: assetId,
    ...(scope ? { scope } : {}),
  });
  return version === undefined
    ? []
    : [{ entity: "media.media_asset", rowId: assetId, version }];
}

export async function act(
  action: string,
  input?: Record<string, unknown>,
  scope?: string | null
): Promise<VaultOutcome | undefined> {
  const body = input ?? {};
  const intentId = globalThis.crypto.randomUUID();
  const optimistic = pendingModel.begin(action, body, intentId);
  try {
    const baseVersions = await baseVersionsFor(action, body, scope);
    const outcome = await window.centraid.write({
      action,
      input: body,
      intentId,
      ...(scope ? { scope } : {}),
      ...(optimistic.length > 0 ? { optimistic } : {}),
      ...(baseVersions.length > 0 ? { baseVersions } : {}),
    });
    pendingModel.applyOutcome(outcome.invocationId ?? intentId, {
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.conflict === undefined ? {} : { conflict: outcome.conflict }),
    });
    return outcome;
  } catch (error) {
    // Nothing reached the outbox — settle to `failed` instead of hanging as
    // `queued` forever.
    pendingModel.applyOutcome(intentId, { status: "failed" });
    // A read-only audience is refused by the shell with a human message; that
    // is narration, not a crash, and it reads like any other refusal.
    const e = error as { message?: string };
    notice(String(e?.message ?? error));
    return undefined;
  }
}
