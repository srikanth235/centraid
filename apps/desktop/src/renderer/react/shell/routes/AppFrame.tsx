import { type JSX, useEffect, useRef } from 'react';
import { themes } from '@centraid/design-tokens';
import { appLiveUrl } from '../../../gateway-client.js';
import type { AppearancePrefs } from '../../../app-shell-context.js';

// The sandboxed user-app iframe host — ports the vanilla mountUserApp
// (app-appview.ts). Every Centraid app (published or draft) is served by the
// openclaw plugin and hosted in an iframe that fills the pane edge-to-edge; the
// app supplies its own chrome. The global theme rides in both the query string
// (server-side settings injection) and the hash (the inline pre-paint bridge).
// Tagged `data-centraid-app` so a global theme change can postMessage every
// running frame.
export default function AppFrame({
  appId,
  accentColor,
  theme,
  bgL,
}: {
  appId: string;
  accentColor: string;
  theme: AppearancePrefs['theme'];
  bgL: number;
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const themeKind = themes[theme]?.kind ?? 'dark';

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let alive = true;
    const onLoad = (): void => {
      try {
        frame.contentWindow?.postMessage({ type: 'centraid:theme', theme: themeKind, bgL }, '*');
      } catch {
        /* noop */
      }
    };
    frame.addEventListener('load', onLoad);
    void appLiveUrl({ id: appId })
      .then((r) => {
        if (!alive) return;
        const qsep = r.url.includes('?') ? '&' : '?';
        const themeQs = `theme=${themeKind}&bgL=${bgL}`;
        frame.src = `${r.url}${qsep}${themeQs}#${themeQs}`;
      })
      .catch(() => {
        if (alive && wrapRef.current) {
          wrapRef.current.innerHTML =
            '<div class="empty">Could not reach the gateway. Check Settings.</div>';
        }
      });
    return () => {
      alive = false;
      frame.removeEventListener('load', onLoad);
    };
    // Re-resolve when the app or the injected theme changes.
  }, [appId, themeKind, bgL]);

  return (
    <div className="app-view-fullbleed" style={{ ['--accent-color' as string]: accentColor }}>
      <div className="app-view-frame" ref={wrapRef}>
        <iframe
          ref={frameRef}
          src="about:blank"
          data-centraid-app="1"
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="no-referrer"
          title="app"
        />
      </div>
    </div>
  );
}
