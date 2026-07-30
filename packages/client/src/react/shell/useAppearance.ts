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

// The local cache key. Bumped for #608 group P: the previous shape persisted
// `bgL: 5` and `accent: 'teal'` on every save, which are exactly the two
// inline overrides that used to outrank the active theme. A cached blob in
// the old shape cannot be told apart from an owner who deliberately moved
// those knobs, so the honest read is to start the new shape clean — the
// gateway-backed prefs reconcile right after first paint either way.
const CACHE_KEY = "appearance.v2";

// Live appearance state, ported from the vanilla app.ts boot block. The local
// Store value is the fast-paint cache (applied synchronously so the first paint
// wears the user's theme); the gateway is the source of truth and reconciles
// after mount. setPrefs writes through: state + Store + <html> + fire-and-
// forget gateway mirror.
export function useAppearance(): AppearanceController {
  const [prefs, setPrefs] = useState<AppearancePrefs>(() => {
    const cached = {
      ...DEFAULT_PREFS,
      ...Store.get<Partial<AppearancePrefs>>(CACHE_KEY, {}),
    };
    return { ...cached, theme: resolveThemeMode(cached.themeMode) };
  });

  // Apply on mount + whenever prefs change, so <html> tracks state.
  useEffect(() => {
    applyPrefsToDocument(prefs);
  }, [prefs]);

  // `system` is a standing mode, not a one-shot snap: follow the OS while it
  // is selected. Re-subscribing on mode change keeps the listener off the
  // event loop entirely for the explicit light/dark picks.
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

  // Reconcile from the gateway once after first paint (silent on failure — the
  // local cache stands in when the gateway is unreachable).
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
      .catch(() => {
        /* gateway unreachable — local cache stands in */
      });
    return () => {
      alive = false;
    };
  }, []);

  const updatePrefs = useCallback((patch: Partial<AppearancePrefs>) => {
    // A mode change re-resolves the applied theme, so callers set the intent
    // and never have to keep the two fields in step themselves.
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
