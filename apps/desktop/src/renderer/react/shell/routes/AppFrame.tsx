import { type CSSProperties, type JSX, useEffect, useRef } from 'react';
import { themes } from '@centraid/design-tokens';
import { appLiveUrl } from '../../../gateway-client.js';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import styles from './AppFrame.module.css';
import atomsCss from '../../styles/atoms.module.css';

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
  // Latest theme, read by the load handler so a frame that loads mid-change
  // paints the current theme without re-resolving its URL.
  const themeRef = useRef({ themeKind, bgL });
  themeRef.current = { themeKind, bgL };

  // Resolve + load the app once per app. The theme rides the initial URL and is
  // re-asserted on load; later theme changes are broadcast live (next effect)
  // rather than reloading the frame, so the app keeps its in-flight state.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let alive = true;
    const onLoad = (): void => {
      try {
        const t = themeRef.current;
        frame.contentWindow?.postMessage(
          { type: 'centraid:theme', theme: t.themeKind, bgL: t.bgL },
          '*',
        );
      } catch {
        /* noop */
      }
    };
    frame.addEventListener('load', onLoad);
    void appLiveUrl({ id: appId })
      .then((r) => {
        if (!alive) return;
        const t = themeRef.current;
        const qsep = r.url.includes('?') ? '&' : '?';
        const themeQs = `theme=${t.themeKind}&bgL=${t.bgL}`;
        frame.src = `${r.url}${qsep}${themeQs}#${themeQs}`;
      })
      .catch(() => {
        if (alive && wrapRef.current) {
          wrapRef.current.innerHTML = `<div class="${atomsCss.empty ?? ''}">Could not reach the gateway. Check Settings.</div>`;
        }
      });
    return () => {
      alive = false;
      frame.removeEventListener('load', onLoad);
    };
  }, [appId]);

  // Live re-theme — postMessage the running frame on a global theme change
  // (vanilla broadcastSettingsToFrames). No src reset, so no reload.
  useEffect(() => {
    try {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'centraid:theme', theme: themeKind, bgL },
        '*',
      );
    } catch {
      /* noop */
    }
  }, [themeKind, bgL]);

  return (
    <div
      className={styles.viewFullbleed}
      style={{ '--accent-color': accentColor } as CSSProperties}
    >
      <div className={styles.viewFrame} ref={wrapRef}>
        {/* Centraid apps are trusted local blueprint code served from the gateway
            origin: they need same-origin (vault fetches, module imports) and
            scripts. NO sandbox attribute, deliberately: with allow-scripts +
            allow-same-origin the sandbox was self-escapable anyway (the framed
            doc can reach the parent and strip the attribute — the browser logs
            exactly that advisory), so it bought no isolation — the real
            boundaries are the app CSP and the vault consent gates. And sandbox
            flags propagate to every NESTED browsing context, where Chromium's
            native PDF viewer refuses to instantiate under any token set —
            silently blanking in-app document previews (docs quick-look). */}
        {/* eslint-disable react/iframe-missing-sandbox */}
        <iframe
          ref={frameRef}
          src="about:blank"
          data-centraid-app="1"
          referrerPolicy="no-referrer"
          title="app"
          allow="clipboard-write; clipboard-read"
        />
        {/* eslint-enable react/iframe-missing-sandbox */}
      </div>
    </div>
  );
}
