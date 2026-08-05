// The three Photos preferences the v4 handoff puts on the MEMBER RECORD
// (§16): `tileSize`, `vaultsOn` and `bandOwner`.
//
// WHAT IS AND IS NOT TRUE HERE. "On the member record" is a real requirement —
// a tile size remembered per surface would make a member preference
// surface-specific, which §4.2 rejects by name. The shell has no member-record
// surface for an inline app to read or write yet: `InlineFrame` carries the
// app bar, the status line and the band, and `window.centraid` carries reads,
// writes and change subscriptions. Nothing else.
//
// So this module is the SEAM and not the storage. It holds the three values
// for the life of the mount and exposes one place to plug the real store into
// when the shell grows one. It deliberately does NOT reach for `localStorage`:
// that would be device-local storage wearing a member-record label, and the
// first member with two devices would find their tile size disagreeing with
// itself — the exact failure the handoff is guarding against. A preference
// that resets on remount is visibly incomplete; one that silently forks is not.
import { DEFAULT_RUNG } from "./layout.ts";
import type { Rung } from "./layout.ts";

/** Everything Photos keeps about the member, and nothing else. */
export interface MemberPrefs {
  /** Tile size, 0–3 = XS/S/M/L (§4.2). */
  tileSize: Rung;
  /** Which vaults are in the merged timeline. Empty means every one. */
  vaultsOn: ReadonlySet<string>;
  /** Who owns the compact bottom band: this app, or the frame (§3.1). */
  bandOwner: "app" | "host";
}

const DEFAULTS: MemberPrefs = {
  tileSize: DEFAULT_RUNG,
  vaultsOn: new Set(),
  bandOwner: "app",
};

/** The store an inline app is given. One implementation today; the shell's
 *  member record is meant to replace it in place. */
export interface MemberPrefsStore {
  read: () => MemberPrefs;
  write: (next: Partial<MemberPrefs>) => void;
}

/**
 * A mount-lifetime store. `onChange` is called after every write so the
 * orchestrator repaints without polling — the app never reads a preference it
 * has not been told changed.
 */
export function createMemberPrefs(
  onChange: () => void,
  seed: Partial<MemberPrefs> = {}
): MemberPrefsStore {
  let held: MemberPrefs = { ...DEFAULTS, ...seed };
  return {
    read: () => held,
    write: (next) => {
      held = { ...held, ...next };
      onChange();
    },
  };
}

/** Step the tile size, clamped to the four rungs. Returns the new rung so a
 *  caller can write it without re-deriving the clamp. */
export function stepTileSize(current: Rung, delta: number): Rung {
  const next = Math.min(3, Math.max(0, current + delta));
  return next as Rung;
}
