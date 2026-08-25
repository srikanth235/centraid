import * as tokens from "@centraid/design";

import "@centraid/client/styles.css";
import {
  installIrohServiceWorkerBridge,
  ensureIrohServiceWorker,
  irohFetch,
  irohVirtualUrl,
  warmIrohTransport,
} from "./iroh-transport.js";
import { installWebChrome } from "./web-chrome.js";
import { installWebHost } from "./web-host.js";

import "./web.css";

window.CentraidIroh = { fetch: irohFetch, url: irohVirtualUrl };
installIrohServiceWorkerBridge();

// The bundled `@font-face` rules ride AHEAD of the token CSS in the same
// string, because `theme-vars.ts` prepends `cssText` as one <style> before
// anything resolves `--font-sans` — a face declared after the first var()
// lookup would let the shell paint a frame in the UA default (issue #707).
// `__CENTRAID_FONT_FACE_CSS__` points at this origin's own `/fonts/`; the
// `centraid-fonts` Vite plugin serves and emits the files there.
window.CentraidTokens = {
  apps: [...tokens.apps],
  cssText: `${__CENTRAID_FONT_FACE_CSS__}\n${tokens.toCss()}`,
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

// Surface the real package version for diagnostics / about UI (issue #468 K9).
// Vite injects __APP_VERSION__ from package.json. Assignment is JS-legal so
// v8 coverage remap (Rolldown) can parse this uncovered entry as a script.
Object.assign(window, { __CENTRAID_VERSION__: __APP_VERSION__ });

installWebHost();
installWebChrome();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void ensureIrohServiceWorker().catch(() => undefined);
  });
}

void import("@centraid/client/react/boot");

// After first paint, and only when this page will actually dial over the WASM
// transport: bring it up during idle rather than in front of the first request
// that needs it (issue #659 C3). The service worker holds the binary across
// visits, so this is paid once per build, not once per visit.
window.addEventListener("load", warmIrohTransport);
