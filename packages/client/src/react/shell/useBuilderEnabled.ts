import { useEffect, useState } from 'react';

/**
 * Reads the `builderEnabled` dev flag (issue #434, Phase 3) from shell settings
 * once on mount. The builder is hidden from the first release — default false —
 * so every builder entry point (the Home composer, "Build new", the ⌘K "Build a
 * new app…" row, draft apps, "Edit with Centraid", and the builder /
 * automation-builder routes) stays gated until the flag is hand-set in the
 * settings JSON and the app is relaunched. `getSettings` is optional-chained so
 * a partial bridge (test harnesses) simply reads false. Deliberately not a live
 * subscription: the flag is dev-only and takes effect on relaunch.
 */
export function useBuilderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.CentraidApi.getSettings?.()
      .then((s) => {
        if (alive && s?.builderEnabled) setEnabled(true);
      })
      .catch(() => {
        /* bridge unavailable (tests) — builder stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}
