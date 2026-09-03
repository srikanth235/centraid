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
    // Intentionally empty.
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
