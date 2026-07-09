import { type CSSProperties, type JSX, useEffect, useState } from 'react';
import { draftPreviewUrl } from '../../../../gateway-client.js';

// The Preview tab — the sandboxed draft iframe (React port of builder.ts
// renderPreview/makePreviewFrame/resolvePreviewSrc). The builder always
// previews the gateway *draft* worktree, so staged agent edits show before an
// explicit Publish. While the draft has no index.html yet (fresh app
// mid-generation) it shows the building skeleton. Theme is synced into the
// frame the same way the running-app view does it: a `#theme=…&bgL=…` hash for
// first paint plus a `centraid:theme` postMessage on load.

const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-same-origin';

export interface PreviewResolved {
  src: string;
  themedSrc: string;
  theme: 'light' | 'dark';
  bgL: number;
}

export interface BuilderPreviewProps {
  appId: string | undefined;
  accentColor: string;
  device: 'mobile' | 'tablet' | 'desktop';
  /** Bumps to force a re-resolve (agent wrote files / manual reload). */
  reloadNonce: number;
  /** Report the resolved source (or null while building) for the URL pill. */
  onResolved: (info: { src: string } | null) => void;
}

function resolveTheme(): { theme: 'light' | 'dark'; bgL: number } {
  const html = document.documentElement;
  const shellTheme = html.dataset.theme || 'dark';
  const themes = window.CentraidTokens.themes as Record<
    string,
    { kind: 'light' | 'dark' } | undefined
  >;
  const theme = themes[shellTheme]?.kind ?? 'dark';
  const bgL = Number((html.style.getPropertyValue('--bg-l') || '5%').replace('%', '').trim());
  return { theme, bgL: Number.isFinite(bgL) ? bgL : 5 };
}

function Skeleton(): JSX.Element {
  return (
    <div className="preview-stage">
      <div className="skel-phone">
        <div className="skel-phone-screen">
          <div className="skel-statusbar">
            <span>9:41</span>
            <span className="skel-battery" />
          </div>
          <div className="skel-body">
            <div className="skel-block skel-block-title" />
            <div className="skel-block skel-block-sub" />
            <div className="skel-block skel-block-card" />
            <div className="skel-grid">
              {Array.from({ length: 28 }).map((_, i) => (
                <div key={i} className="skel-cell" />
              ))}
            </div>
            <div className="skel-block skel-block-row" />
            <div className="skel-block skel-block-row" />
            <div className="skel-block skel-block-row" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BuilderPreview({
  appId,
  accentColor,
  device,
  reloadNonce,
  onResolved,
}: BuilderPreviewProps): JSX.Element {
  const [resolved, setResolved] = useState<PreviewResolved | null>(null);

  useEffect(() => {
    let alive = true;
    setResolved(null);
    void (async () => {
      if (!appId) {
        if (alive) onResolved(null);
        return;
      }
      let src: string | undefined;
      try {
        const r = await draftPreviewUrl(appId);
        if (r.available) src = r.url;
      } catch {
        /* show building skeleton */
      }
      if (!alive) return;
      if (!src) {
        setResolved(null);
        onResolved(null);
        return;
      }
      const { theme, bgL } = resolveTheme();
      const sep = src.includes('#') ? '&' : '#';
      setResolved({ src, themedSrc: `${src}${sep}theme=${theme}&bgL=${bgL}`, theme, bgL });
      onResolved({ src });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, device, reloadNonce]);

  if (!resolved) {
    return (
      <>
        <Skeleton />
        <div className="preview-building-pill">
          <span className="preview-building-dot" />
          Building · preview refreshes on save
        </div>
      </>
    );
  }

  const cardClass =
    device === 'mobile'
      ? 'preview-card preview-card-mobile'
      : device === 'tablet'
        ? 'preview-card preview-card-tablet'
        : 'preview-card';

  return (
    <>
      <div className="preview-stage">
        <div className="preview-card-wrap" style={{ display: 'contents' }}>
          <div className={cardClass} style={{ '--accent-color': accentColor } as CSSProperties}>
            <iframe
              title="App preview"
              src={resolved.themedSrc}
              style={{ border: 0, height: '100%', width: '100%' }}
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              data-centraid-app="1"
              onLoad={(e) => {
                try {
                  e.currentTarget.contentWindow?.postMessage(
                    { type: 'centraid:theme', theme: resolved.theme, bgL: resolved.bgL },
                    '*',
                  );
                } catch {
                  /* noop */
                }
              }}
            />
          </div>
        </div>
      </div>
      <div className="preview-live-badge">
        <span className="preview-live-dot" />
        Draft · staged
      </div>
    </>
  );
}
