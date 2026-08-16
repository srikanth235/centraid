// Inject `Authorization: Bearer <gatewayToken>` (and the addressed vault) on
// renderer traffic going to the configured gateway origin, for the requests
// that cannot carry their own headers — `<img src>`, media, and other plain
// subresource loads pointed at the gateway when it runs with
// `auth.mode: "token"`. A request that already carries an Authorization
// header (every `gateway-client` fetch) is left exactly as it is.
//
// The CSP `frame-ancestors` relaxation that used to sit beside this retired
// with the app iframe it existed for (issue #799): this renderer frames
// nothing, so it needs no response rewrite.
//
// The hook is scoped to the configured gateway origin, so other traffic in
// the renderer is untouched. Settings live in the main process; call
// `refreshAuthInjector()` after saving so changes take effect without an
// app restart.
//
// Pure rewrite rules live in `auth-injector-core.ts` (unit-tested without
// Electron). This file only wires them onto `session.webRequest`.

import { session } from "electron";
import type { Session } from "electron";

import { applyOutgoingAuthHeaders } from "./auth-injector-core.js";
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
}

export async function refreshAuthInjector(): Promise<void> {
  state = await readState();
}
