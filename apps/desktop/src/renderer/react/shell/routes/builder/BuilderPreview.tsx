import { type CSSProperties, type JSX, useEffect, useState } from 'react';
import { draftPreviewUrl } from '../../../../gateway-client.js';
import styles from './BuilderPreview.module.css';
import { cx } from '../../../ui/cx.js';

// The Preview tab — the sandboxed draft iframe (React port of builder.ts
// renderPreview/makePreviewFrame/resolvePreviewSrc). The builder always
// previews the gateway *draft* worktree, so staged agent edits show before an
// explicit Publish. While the draft has no index.html yet (fresh app
// mid-generation) it shows the building skeleton. Theme is synced into the
// frame the same way the running-app view does it: a `#theme=…&bgL=…` hash for
// first paint plus a `centraid:theme` postMessage on load.

// NO sandbox on the preview iframe, matching AppFrame: allow-scripts +
// allow-same-origin made the sandbox self-escapable (zero isolation; the CSP
// and consent gates are the real boundary), and sandbox flags propagate into
// nested browsing contexts where Chromium's PDF viewer refuses to run —
// blanking in-app document previews (docs quick-look) in drafts too.

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
    <div className={styles.stage}>
      <div className={styles.phone}>
        <div className={styles.phoneScreen}>
          <div className={styles.statusbar}>
            <span>9:41</span>
            <span className={styles.battery} />
          </div>
          <div className={styles.body}>
            <div className={cx(styles.block, styles.blockTitle)} />
            <div className={cx(styles.block, styles.blockSub)} />
            <div className={cx(styles.block, styles.blockCard)} />
            <div className={styles.grid}>
              {Array.from({ length: 28 }).map((_, i) => (
                <div key={i} className={styles.cell} />
              ))}
            </div>
            <div className={cx(styles.block, styles.blockRow)} />
            <div className={cx(styles.block, styles.blockRow)} />
            <div className={cx(styles.block, styles.blockRow)} />
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
        <div className={styles.buildingPill}>
          <span className={styles.buildingDot} />
          Building · preview refreshes on save
        </div>
      </>
    );
  }

  const cardClass =
    device === 'mobile'
      ? cx(styles.card, styles.cardMobile)
      : device === 'tablet'
        ? cx(styles.card, styles.cardTablet)
        : styles.card;

  return (
    <>
      <div className={styles.stage}>
        <div style={{ display: 'contents' }}>
          <div className={cardClass} style={{ '--accent-color': accentColor } as CSSProperties}>
            <iframe
              title="App preview"
              src={resolved.themedSrc}
              style={{ border: 0, height: '100%', width: '100%' }}
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
      <div className={styles.liveBadge}>
        <span className={styles.liveDot} />
        Draft · staged
      </div>
    </>
  );
}
