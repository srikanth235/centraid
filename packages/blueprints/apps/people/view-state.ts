// The state People opens on, as two pure factories.
//
// Pure and DOM-free, in their own file for the reason `docs/view-state.ts`
// exists: the shape of an app's state is a decision worth reading on its own,
// and an orchestrator that also defines it grows a hundred lines nobody
// revisits. `app-root.tsx` calls each of these exactly once and then mutates
// the returned object in place for the life of the mount.
import type { AppData, AppState } from "./types.ts";

/**
 * The cadence a new person opens on — the middle chip of `CADENCE_CHIPS`
 * (people-copy.ts), named here rather than typed as a bare 30 at the call
 * site. ZERO IS A VALUE THIS CONTRACT HOLDS (the `Never` chip), and it is
 * deliberately not the default: a person added with no cadence would never
 * reach the Reconnect shelf, which is the shelf the app is for.
 */
export const DEFAULT_CADENCE = 30;

/** The roster opens on People, with nothing filtered and nobody open. */
export function makeState(): AppState {
  return {
    shelf: null,
    personId: null,
    filter: "all",
    search: "",
    searchStatus: "resting",
    searchSeq: 0,
    searchResults: null,
    collapsed: {},
    composer: null,
    draft: null,
    log: null,
    confirm: null,
    mergeSourceId: null,
    merged: false,
    narrow: false,
  };
}

/** Nothing has been read yet — which is NOT the same as "there is nothing",
 *  and is why every empty state is gated on `loaded` rather than on a count
 *  (`_shared/view-state-kit.ts`). */
export function makeData(): AppData {
  return {
    people: [],
    truncated: false,
    // Nothing has been read, so the sharing plane has not answered either.
    // False draws exactly the link-free roster, which is the honest first
    // paint: a ring on every avatar before the first read would be a claim.
    linksAvailable: false,
    person: null,
    dashboard: null,
    trash: [],
  };
}
