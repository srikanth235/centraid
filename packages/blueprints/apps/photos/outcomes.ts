// Outcome narration + the write trampoline (shared pattern across apps). No
// domain (asset/album) state lives here — it's generic plumbing, which is
// exactly why every action module and every component that needs to fire a
// command imports it directly instead of threading it through props.
//
// MULTI-SCOPE (#599). Mounted over N scopes, a write has to say WHICH
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
import { outcomeMessage } from "@centraid/design/elements";

import type { WriteTarget } from "../_shared/write-target.ts";

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
 * calls below are no-ops rather than a banner the app draws for itself: this
 * app has no chrome of its own, so there is no `#noticeBanner` to write to.
 */
export interface StatusNote {
  text: string;
  undo?: () => void;
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
export async function act(
  action: string,
  input?: Record<string, unknown>,
  scope?: string | null
): Promise<VaultOutcome | undefined> {
  try {
    return await window.centraid.write({
      action,
      input,
      ...(scope ? { scope } : {}),
    });
  } catch (error) {
    // A read-only audience is refused by the shell with a human message; that
    // is narration, not a crash, and it reads like any other refusal.
    const e = error as { message?: string };
    notice(String(e?.message ?? error));
    return undefined;
  }
}
