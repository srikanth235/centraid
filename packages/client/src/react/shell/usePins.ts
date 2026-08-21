import { useCallback, useState } from "react";

import { DEFAULT_PINS, isPinned } from "./launcherModel.js";
import type { PinSet, ShellPage } from "./launcherModel.js";
import { Store } from "./store.js";

// Launcher pins — which destinations stand in the stem (and in the compact
// band), and which live only behind the All-apps sheet.
//
// Pins are USER DATA, not a layout preference, so they persist. They go
// through the same client-local `Store` that already carries starred apps and
// the appearance cache — `store.ts` names "home pins" in its own docstring —
// rather than inventing a second persistence path for one map of booleans.
//
// The stored value is an id→true map, matching `useStarred`: absent means
// unpinned, so unpinning DELETES the key instead of writing `false`. That
// keeps the blob the size of the member's actual choices, and it means a
// destination added in a later build is simply not in anyone's map.

const STORE_KEY = "launcher.pins";

export interface PinController {
  pins: PinSet;
  isPinned: (id: ShellPage) => boolean;
  togglePin: (id: ShellPage) => void;
}

/** First run has no stored map, so it starts from the shipped default set. */
function seed(): Record<string, boolean> {
  return Object.fromEntries(DEFAULT_PINS.map((id) => [id, true]));
}

export function usePins(): PinController {
  const [pins, setPins] = useState<Record<string, boolean>>(() =>
    Store.get<Record<string, boolean>>(STORE_KEY, seed())
  );

  const togglePin = useCallback((id: ShellPage) => {
    // Home is pinned by law (`isPinned`), so a toggle on it is a no-op rather
    // than a write that the model would then ignore.
    if (id === "home") return;
    setPins((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      Store.set(STORE_KEY, next);
      return next;
    });
  }, []);

  const has = useCallback((id: ShellPage) => isPinned(pins, id), [pins]);

  return { isPinned: has, pins, togglePin };
}
