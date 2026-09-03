import { useCallback, useState } from "react";

import { DEFAULT_PINS, isPinned } from "./launcherModel.js";
import type { PinSet, ShellPage } from "./launcherModel.js";
import { Store } from "./store.js";

const STORE_KEY = "launcher.pins";

export interface PinController {
  pins: PinSet;
  isPinned: (id: ShellPage) => boolean;
  togglePin: (id: ShellPage) => void;
}

function seed(): Record<string, boolean> {
  return Object.fromEntries(DEFAULT_PINS.map((id) => [id, true]));
}

export function usePins(): PinController {
  const [pins, setPins] = useState<Record<string, boolean>>(() =>
    Store.get<Record<string, boolean>>(STORE_KEY, seed())
  );

  const togglePin = useCallback((id: ShellPage) => {
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
