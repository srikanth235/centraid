// Once per mount.
import type { AppData, AppState } from "./types.ts";

/** Zero is a value (`Never`). */
export const DEFAULT_CADENCE = 30;

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

/** Gate empties on `loaded`, not counts. */
export function makeData(): AppData {
  return {
    people: [],
    truncated: false,
    linksAvailable: false,
    person: null,
    dashboard: null,
    trash: [],
  };
}
