import { useCallback, useEffect, useRef, useState } from "react";

import type { AppearancePrefs } from "../../app-shell-context.js";
import { getUserPrefs, saveUserPrefs } from "../../gateway-client.js";
import {
  applyPrefsToDocument,
  DEFAULT_PREFS,
  LIGHT_SCHEME_QUERY,
  pickAppearance,
  resolveThemeMode,
  toRemoteShape,
} from "./appearance.js";
import { Store } from "./store.js";

export interface AppearanceController {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
}

const CACHE_KEY = "appearance.v2";

export function useAppearance(): AppearanceController {
  const [prefs, setPrefs] = useState<AppearancePrefs>(() => {
    const cached = {
      ...DEFAULT_PREFS,
      ...Store.get<Partial<AppearancePrefs>>(CACHE_KEY, {}),
    };
    return { ...cached, theme: resolveThemeMode(cached.themeMode) };
  });

  useEffect(() => {
    applyPrefsToDocument(prefs);
  }, [prefs]);

  const mode = prefs.themeMode;
  useEffect(() => {
    if (mode !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia(LIGHT_SCHEME_QUERY);
    const sync = (): void => {
      setPrefs((prev) =>
        prev.themeMode === "system"
          ? { ...prev, theme: resolveThemeMode("system") }
          : prev
      );
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [mode]);

  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    let alive = true;
    getUserPrefs()
      .then((remote) => {
        const recognised = pickAppearance(remote);
        if (alive && Object.keys(recognised).length > 0) {
          setPrefs((prev) => {
            const next = { ...prev, ...recognised };
            Store.set(CACHE_KEY, next);
            return next;
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const updatePrefs = useCallback((patch: Partial<AppearancePrefs>) => {
    const resolved =
      patch.themeMode === undefined
        ? patch
        : { ...patch, theme: resolveThemeMode(patch.themeMode) };
    setPrefs((prev) => {
      const next = { ...prev, ...resolved };
      Store.set(CACHE_KEY, next);
      return next;
    });
    const remotePatch = toRemoteShape(resolved);
    if (Object.keys(remotePatch).length > 0) {
      void saveUserPrefs(remotePatch).catch(() => undefined);
    }
  }, []);

  return { prefs, setPrefs: updatePrefs };
}
