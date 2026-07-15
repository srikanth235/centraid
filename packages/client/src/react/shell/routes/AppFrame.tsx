import { type CSSProperties, type JSX, useEffect, useMemo, useRef } from 'react';
import { themes } from '@centraid/design-tokens';
import { appLiveUrl } from '../../../gateway-client.js';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import styles from './AppFrame.module.css';
import {
  attachAppFrameReplicaBridge,
  type AppFrameResourceRequest,
  type AppFrameResourceResponse,
} from './appFrameReplicaBridge.js';
import { isOpaqueAppTunnelUrl, prepareOpaqueAppDocument } from './opaqueAppDocument.js';
import atomsCss from '../../styles/atoms.module.css';

const APP_FRAME_URL_STORAGE = 'centraid.client.v1.app-frame-urls';
const IROH_VIRTUAL_PREFIX = '/__centraid_iroh__/';

interface RememberedAppFrameUrls {
  scope: string;
  urls: Record<string, string>;
}

function replayableTunnelUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === window.location.origin && url.pathname.startsWith(IROH_VIRTUAL_PREFIX);
  } catch {
    return false;
  }
}

function readRememberedUrl(scope: string, appId: string): string | undefined {
  try {
    const saved = JSON.parse(
      localStorage.getItem(APP_FRAME_URL_STORAGE) ?? '{}',
    ) as Partial<RememberedAppFrameUrls>;
    if (saved.scope !== scope || !saved.urls) return undefined;
    const url = saved.urls[appId];
    return typeof url === 'string' && replayableTunnelUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function writeRememberedUrl(scope: string, appId: string, url: string): void {
  if (!replayableTunnelUrl(url)) return;
  let urls: Record<string, string> = {};
  try {
    const saved = JSON.parse(
      localStorage.getItem(APP_FRAME_URL_STORAGE) ?? '{}',
    ) as Partial<RememberedAppFrameUrls>;
    if (saved.scope === scope && saved.urls) urls = saved.urls;
  } catch {
    urls = {};
  }
  localStorage.setItem(
    APP_FRAME_URL_STORAGE,
    JSON.stringify({ scope, urls: { ...urls, [appId]: url } }),
  );
}

async function resolveAppFrameUrl(appId: string): Promise<string> {
  const gateway = await window.CentraidApi.getGatewayAuth();
  const durable =
    gateway.rememberDevice === true &&
    typeof gateway.gatewayId === 'string' &&
    typeof gateway.vaultId === 'string';
  const scope = durable ? `${gateway.gatewayId}\u0000${gateway.vaultId}` : undefined;
  if (!scope) localStorage.removeItem(APP_FRAME_URL_STORAGE);
  try {
    const { url } = await appLiveUrl({ id: appId });
    if (scope) writeRememberedUrl(scope, appId, url);
    return url;
  } catch (error) {
    const remembered = scope ? readRememberedUrl(scope, appId) : undefined;
    if (remembered) return remembered;
    throw error;
  }
}

// The sandboxed user-app iframe host — ports the vanilla mountUserApp
// (app-appview.ts). Every Centraid app (published or draft) is served by the
// gateway and hosted in an iframe that fills the pane edge-to-edge; the
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
  const resourceFetchRef = useRef<
    ((request: AppFrameResourceRequest) => Promise<AppFrameResourceResponse>) | undefined
  >(undefined);
  const documentNonce = useMemo(() => `${appId}-${crypto.randomUUID()}`, [appId]);
  const themeKind = themes[theme]?.kind ?? 'dark';
  // Latest theme, read by the load handler so a frame that loads mid-change
  // paints the current theme without re-resolving its URL.
  const themeRef = useRef({ themeKind, bgL });
  themeRef.current = { themeKind, bgL };

  // Query-only app bundles use this shell-owned RPC for local reads, durable
  // intents and dependency invalidations. The bridge authenticates both the
  // sending Window and this component's app id before touching the replica.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    return attachAppFrameReplicaBridge(frame, appId, {
      documentNonce,
      fetchResource: (request) => {
        const fetchResource = resourceFetchRef.current;
        if (!fetchResource) {
          throw Object.assign(new Error('App resource bridge is unavailable.'), {
            code: 'APP_RESOURCE_UNAVAILABLE',
          });
        }
        return fetchResource(request);
      },
    });
  }, [appId, documentNonce]);

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
    resourceFetchRef.current = undefined;
    void resolveAppFrameUrl(appId)
      .then(async (url) => {
        if (!alive) return;
        const t = themeRef.current;
        const qsep = url.includes('?') ? '&' : '?';
        const themeQs = `theme=${t.themeKind}&bgL=${t.bgL}`;
        const themedUrl = `${url}${qsep}${themeQs}`;
        if (isOpaqueAppTunnelUrl(themedUrl)) {
          const prepared = await prepareOpaqueAppDocument({
            appId,
            launchUrl: themedUrl,
            documentNonce,
          });
          if (!alive) return;
          resourceFetchRef.current = prepared.fetchResource;
          frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads');
          frame.src = prepared.documentUrl;
          return;
        }
        // Direct desktop/gateway URLs already have a distinct origin. Keep
        // their natural browser behavior (nested viewers, downloads, etc.).
        resourceFetchRef.current = undefined;
        frame.removeAttribute('sandbox');
        frame.src = `${themedUrl}#${themeQs}&bridge=${encodeURIComponent(documentNonce)}`;
      })
      .catch(() => {
        if (alive && wrapRef.current) {
          wrapRef.current.innerHTML = `<div class="${atomsCss.empty ?? ''}">Could not reach the gateway. Check Settings.</div>`;
        }
      });
    return () => {
      alive = false;
      resourceFetchRef.current = undefined;
      frame.removeEventListener('load', onLoad);
    };
  }, [appId, documentNonce]);

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
        {/* Iroh apps are parent-fetched into a nonce-stamped data document and
            run without allow-same-origin, so app code receives an opaque
            principal and cannot reach shell DOM, OPFS, IndexedDB, or cookies.
            Direct gateway URLs have a natural cross-origin principal; the
            load effect removes this initial sandbox before navigating them. */}
        <iframe
          ref={frameRef}
          src="about:blank"
          sandbox=""
          data-centraid-app="1"
          referrerPolicy="no-referrer"
          title="app"
          allow="clipboard-write; clipboard-read"
        />
      </div>
    </div>
  );
}
