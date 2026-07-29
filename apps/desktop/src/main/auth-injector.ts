// Wire two interceptors on the renderer's session for traffic going to the
// remote gateway:
//
//   1. Outgoing: inject `Authorization: Bearer <gatewayToken>` so the iframe
//      can load `<gatewayUrl>/centraid/<id>/` when the gateway is configured
//      with `auth.mode: "token"`. Browsers can't attach arbitrary headers to
//      an `<iframe src="...">`, so without this the gateway returns 401.
//
//   2. Incoming: rewrite the `frame-ancestors` directive of the response CSP.
//      The gateway emits `frame-ancestors 'self'` for static asset responses,
//      which blocks the Electron renderer (whose page is `file://`) from
//      framing the app. Other CSP directives (script-src, etc.) are left
//      alone so the app's own content restrictions still apply.
//
// Both hooks are scoped to the configured gateway origin, so other traffic
// in the renderer is untouched. Settings live in the main process; call
// `refreshAuthInjector()` after saving so changes take effect without an
// app restart.
//
// Pure rewrite rules live in `auth-injector-core.ts` (unit-tested without
// Electron). This file only wires them onto `session.webRequest`.

import { session } from "electron";
import type { Session } from "electron";

import {
  applyIncomingFrameRelaxation,
  applyOutgoingAuthHeaders,
} from "./auth-injector-core.js";
import type { AuthInjectorSnapshot } from "./auth-injector-core.js";
import { loadSettings } from "./settings.js";

let state: AuthInjectorSnapshot | null = null;
let installed = false;

async function readState(): Promise<AuthInjectorSnapshot> {
  const settings = await loadSettings();
  let gatewayOrigin = "";
  try {
    gatewayOrigin = new URL(settings.gatewayUrl).origin;
  } catch {
    /* invalid URL — leave empty so the filter no-ops */
  }
  return {
    gatewayOrigin,
    gatewayToken: settings.gatewayToken ?? "",
    gatewayVaultId: settings.activeVaultId ?? "",
  };
}

export async function installAuthInjector(
  targetSession?: Session
): Promise<void> {
  state = await readState();
  if (installed) return;
  installed = true;

  const s = targetSession ?? session.defaultSession;

  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const snapshot = state;
    if (!snapshot) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({
      requestHeaders: applyOutgoingAuthHeaders(
        details.requestHeaders,
        snapshot,
        details.url
      ),
    });
  });

  s.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: applyIncomingFrameRelaxation(
        details.responseHeaders,
        state,
        details.url
      ),
    });
  });
}

export async function refreshAuthInjector(): Promise<void> {
  state = await readState();
}
