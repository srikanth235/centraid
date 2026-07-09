import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppearancePrefs } from '../../app-shell-context.js';
import { getUserPrefs, saveUserPrefs } from '../../gateway-client.js';
import { applyPrefsToDocument, DEFAULT_PREFS, pickAppearance, toRemoteShape } from './appearance.js';

export interface AppearanceController {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
}

// Live appearance state, ported from the vanilla app.ts boot block. The local
// Store value is the fast-paint cache (applied synchronously so the first paint
// wears the user's theme); the gateway is the source of truth and reconciles
// after mount. `bgL` is locked to 5 (the dark ramp anchor, read-only in
// Settings). setPrefs writes through: state + Store + <html> + fire-and-forget
// gateway mirror.
export function useAppearance(): AppearanceController {
  const [prefs, setPrefsState] = useState<AppearancePrefs>(() => ({
    ...DEFAULT_PREFS,
    ...Store.get<Partial<AppearancePrefs>>('appearance', {}),
    bgL: 5,
  }));

  // Apply on mount + whenever prefs change, so <html> tracks state.
  useEffect(() => {
    applyPrefsToDocument(prefs);
  }, [prefs]);

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
          setPrefsState((prev) => {
            const next = { ...prev, ...recognised, bgL: 5 };
            Store.set('appearance', next);
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

  const setPrefs = useCallback((patch: Partial<AppearancePrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      Store.set('appearance', next);
      return next;
    });
    const remotePatch = toRemoteShape(patch);
    if (Object.keys(remotePatch).length > 0) {
      void saveUserPrefs(remotePatch).catch(() => undefined);
    }
  }, []);

  return { prefs, setPrefs };
}
