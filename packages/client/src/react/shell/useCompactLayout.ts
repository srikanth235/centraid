import { useEffect, useState } from "react";

/**
 * The compact form-factor signal, as a hook.
 *
 * PRESENTATION ONLY — docs/platform-gating.md: a narrow viewport is never a
 * trust or capability boundary, so nothing about auth, grants, or gateway
 * reach may branch on this. It exists so the shell can decide whether the
 * sidebar is a docked column or an overlay drawer, which is a question the
 * CSS answers for layout but React must also answer for BEHAVIOUR (does a
 * scrim mount, does navigating dismiss the rail, does toggling write the
 * desktop preference).
 *
 * The breakpoint is duplicated in chrome.module.css by necessity — CSS can't
 * read a JS constant and a media query can't be interpolated into a CSS
 * module. Change one, change the other; the pair is asserted in
 * useCompactLayout.test.ts.
 */
export const COMPACT_MAX_WIDTH = 720;

const QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof matchMedia !== "function") return false;
    return matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const sync = (): void => setCompact(mq.matches);
    // Re-read on subscribe: a resize between the initial render and this
    // effect would otherwise leave the shell laid out for the wrong width.
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return compact;
}
