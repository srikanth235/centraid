// The Agenda preferences that belong to the MEMBER rather than to a surface:
// which day-context layers are switched on.
//
// WHAT IS AND IS NOT TRUE HERE — the same statement Photos' `member-prefs.ts`
// makes, and deliberately the same shape so the two are replaced together. A
// layer the member switched off is a preference about their calendar, not
// about the laptop they switched it off on. The shell has no member-record
// surface an inline app can read or write yet: `InlineFrame` carries the app
// bar, the status line and the band, and `window.centraid` carries reads,
// writes and change subscriptions. Nothing else.
//
// So this module is the SEAM and not the storage. It holds the switches for
// the life of the mount and exposes one place to plug the real store into. It
// deliberately does NOT reach for `localStorage`: that would be device-local
// storage wearing a member-record label, and the first member with a laptop
// and a phone would find Birthdays on in one and off in the other. A
// preference that resets on remount is visibly incomplete; one that silently
// forks is not.
import { ALL_LAYERS_ON } from "./day-context.ts";
import type { LayerId, LayerState } from "./day-context.ts";

/** Everything Agenda keeps about the member, and nothing else. */
export interface MemberPrefs {
  /** The day-context layers the member has switched on. */
  layers: LayerState;
}

const DEFAULTS: MemberPrefs = { layers: ALL_LAYERS_ON };

/** The store an inline app is given. One implementation today; the shell's
 *  member record is meant to replace it in place. */
export interface MemberPrefsStore {
  read: () => MemberPrefs;
  toggleLayer: (id: LayerId) => void;
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
    toggleLayer: (id) => {
      held = { ...held, layers: { ...held.layers, [id]: !held.layers[id] } };
      onChange();
    },
  };
}
