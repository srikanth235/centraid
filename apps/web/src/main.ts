import * as tokens from '@centraid/design-tokens';
import '@centraid/client/styles.css';
import { installWebHost } from './web-host.js';
import { installWebChrome } from './web-chrome.js';
import {
  installIrohServiceWorkerBridge,
  ensureIrohServiceWorker,
  irohFetch,
  irohVirtualUrl,
} from './iroh-transport.js';
import { loadConnection, saveConnection } from './web-state.js';
import './web.css';

if (!loadConnection().baseUrl && loadConnection().transport !== 'iroh') {
  const hosted = await fetch('/web-config.json')
    .then((response) =>
      response.ok ? (response.json() as Promise<{ gatewayUrl?: string }>) : undefined,
    )
    .catch(() => undefined);
  if (hosted?.gatewayUrl) saveConnection({ baseUrl: hosted.gatewayUrl });
}

window.CentraidIroh = { fetch: irohFetch, url: irohVirtualUrl };
installIrohServiceWorkerBridge();

window.CentraidTokens = {
  apps: [...tokens.apps],
  cssText: tokens.toCss(),
  fonts: tokens.fonts,
  icons: tokens.icons,
  palette: tokens.palette,
  radii: tokens.radii,
  spacing: tokens.spacing,
  themes: tokens.themes,
  themePresets: [...tokens.THEME_PRESETS],
  tileFinish: tokens.tileFinish,
  type: tokens.type,
};

installWebHost();
installWebChrome();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void ensureIrohServiceWorker().catch(() => undefined);
  });
}

void import('@centraid/client/react/boot');
