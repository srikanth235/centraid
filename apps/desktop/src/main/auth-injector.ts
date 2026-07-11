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

import { session, type Session } from 'electron';
import { loadSettings } from './settings.js';

interface State {
  gatewayOrigin: string;
  gatewayToken: string;
  /** The vault the client addresses (issue #289) — `x-centraid-vault`. */
  gatewayVaultId: string;
}

let state: State | null = null;
let installed = false;

async function readState(): Promise<State> {
  const settings = await loadSettings();
  let gatewayOrigin = '';
  try {
    gatewayOrigin = new URL(settings.gatewayUrl).origin;
  } catch {
    /* invalid URL — leave empty so the filter no-ops */
  }
  return {
    gatewayOrigin,
    gatewayToken: settings.gatewayToken ?? '',
    gatewayVaultId: settings.activeVaultId ?? '',
  };
}

/** The vault-addressing header (mirrors the gateway's constant, #289). */
const VAULT_HEADER = 'x-centraid-vault';

export async function installAuthInjector(targetSession?: Session): Promise<void> {
  state = await readState();
  if (installed) return;
  installed = true;

  const s = targetSession ?? session.defaultSession;

  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const snapshot = state;
    if (!snapshot || !snapshot.gatewayOrigin || !snapshot.gatewayToken) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!matchesGateway(details.url, snapshot.gatewayOrigin)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const headers = { ...details.requestHeaders };
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    if (!hasAuth) {
      headers.Authorization = `Bearer ${snapshot.gatewayToken}`;
    }
    // Address the client's vault (issue #289) so an iframed app's own
    // requests land on the same vault the shell does. Don't override a
    // header the app somehow set itself.
    if (snapshot.gatewayVaultId) {
      const hasVault = Object.keys(headers).some((k) => k.toLowerCase() === VAULT_HEADER);
      if (!hasVault) headers[VAULT_HEADER] = snapshot.gatewayVaultId;
    }
    callback({ requestHeaders: headers });
  });

  s.webRequest.onHeadersReceived((details, callback) => {
    const snapshot = state;
    if (!snapshot || !snapshot.gatewayOrigin) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!matchesGateway(details.url, snapshot.gatewayOrigin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = relaxFrameAncestors(details.responseHeaders ?? {});
    callback({ responseHeaders: headers });
  });
}

function matchesGateway(url: string, gatewayOrigin: string): boolean {
  try {
    return new URL(url).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

// CSP directives are case-insensitive, separated by `;`. The renderer is
// trusted to frame the gateway, so we strip `frame-ancestors` rather than
// trying to allowlist the file:// origin (which CSP matches awkwardly).
function relaxFrameAncestors(
  responseHeaders: Record<string, string[] | string>,
): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  for (const [name, value] of Object.entries(responseHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      const values = Array.isArray(value) ? value : [value];
      out[name] = values.map(stripFrameAncestors).filter((v) => v.length > 0);
      continue;
    }
    if (lower === 'x-frame-options') continue;
    out[name] = value;
  }
  return out;
}

function stripFrameAncestors(policy: string): string {
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d))
    .join('; ');
}

export async function refreshAuthInjector(): Promise<void> {
  state = await readState();
}
