import { SEAT_STORE_FLAG } from "@centraid/client/replica/seat";
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
// lookup would let the shell paint a frame in the UA default (#707).
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

// Package version for diagnostics / about UI (#468 K9). Vite injects
// __APP_VERSION__ from package.json. Object.assign so v8 coverage remap
// (Rolldown) can parse this uncovered entry as a script.
Object.assign(window, { __CENTRAID_VERSION__: __APP_VERSION__ });

// THE SEAT STORE'S FLAG (#996, wave 2). The new store lands beside the old
// one, off by default; this is the one build-time lever that turns it on for a
// whole run, which is how the e2e lane exercises the flag ON without every
// spec having to carry a query string. A member turns it on with
// `?seatStore=1`; nothing here overrides that either way.
if (import.meta.env.VITE_CENTRAID_SEAT_STORE === "1") {
  try {
    window.localStorage.setItem(SEAT_STORE_FLAG, "1");
  } catch {
    // A browser with site data blocked keeps the old store. Not an error.
  }
}

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
// that needs it (#659). The service worker holds the binary across
// visits, so this is paid once per build, not once per visit.
window.addEventListener("load", warmIrohTransport);
