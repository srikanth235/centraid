/**
 * Pure logic for finishing a `needs-auth` connection FROM THE PHONE (#647
 * review of PR #655). No React, no Expo imports — the screen owns the browser
 * session, this module owns the rules.
 *
 * Why the phone cannot reuse the PWA shape
 * ----------------------------------------
 * Mobile must not POST `{surface:"web"}` and then `Linking.openURL(authUrl)`
 * into the SYSTEM browser. Both halves are wrong here:
 *
 *  - `surface:"web"` makes the Assist Worker 303 the callback to
 *    `https://app.centraid.dev/oauth/finish#…` (apps/oauth-worker/src/worker.ts
 *    `state.startsWith("w.")`). That is the PWA's finish route; it delivers the
 *    handoff over *its* gateway session, and there is no path from that page
 *    back into this app. The ceremony is bound to the initiating client session
 *    AND enrolled device (connection-broker.ts `completeAssistAuthorization`
 *    rejects a mismatch), so the PWA could not redeem it even if it ran.
 *  - The system browser backgrounds this app, and the gateway is only reachable
 *    through the phone-local tunnel proxy on `http://127.0.0.1:<port>`
 *    (lib/phone-link.ts). A suspended app serves nothing, so the BYO leg — whose
 *    default `redirect_uri` is exactly that loopback host
 *    (connections-routes.ts, `POST /connections/<id>/authorize`) — can never
 *    land.
 *
 * What works instead
 * ------------------
 * The screen opens the ceremony in an *in-app* auth session
 * (`expo-web-browser` → `ASWebAuthenticationSession` on iOS, Chrome Custom Tabs
 * on Android). The host app stays active on both platforms, so:
 *
 *  - **Assist** — we ask for `surface:"desktop"`, the non-web branch of the
 *    Worker, which returns `centraid://oauth/finish#code&state&receipt`. That is
 *    this app's own scheme (`app.config.ts` `scheme: "centraid"`), and it is the
 *    redirect the auth session is watching for, so the session resolves with the
 *    handoff *in-process* — no app relaunch, no deep-link race. The app then
 *    POSTs it to `/connections/assist/complete` with the SAME persisted
 *    `x-centraid-client-session` it began with, over the same paired device, so
 *    both halves of the broker's binding check hold.
 *  - **BYO** — the provider redirects to the gateway's own bearer-free callback
 *    through the still-alive loopback proxy; the gateway completes the ceremony
 *    server-side and renders its "Connected" page inside the session. Nothing
 *    comes back to the app, so the session ends as a plain dismissal and the
 *    caller simply re-reads the Notifications: an authorized connection is no longer
 *    `needs-auth`, so the decision disappears.
 *
 * "desktop" is the wire word for "return by `centraid://` deep link" — the
 * gateway offers no third value, and changing that contract is a gateway change.
 */

/** The redirect the in-app auth session watches for; also the Worker's non-web return. */
export const ASSIST_RETURN_URL = "centraid://oauth/finish";

/**
 * The surface asked of `POST /connections/<id>/authorize`. See the module note:
 * this selects the Worker's deep-link return, which mobile *can* receive.
 */
export const MOBILE_AUTHORIZE_SURFACE = "desktop";

/** The code-courier tuple the gateway exchanges for sealed tokens. */
export interface AssistHandoff {
  state: string;
  code: string;
  receipt: string;
}

export type ReconnectOutcome =
  /** Assist returned the courier tuple; deliver it to the gateway. */
  | { kind: "assist-handoff"; handoff: AssistHandoff }
  /** The owner said no on the consent screen. */
  | { kind: "declined" }
  /** The provider answered with an error instead of a code. */
  | { kind: "provider-error" }
  /**
   * The browser closed without a deep link. Either the owner backed out, or a
   * BYO ceremony finished at the gateway's own callback page. Indistinguishable
   * from here on purpose — re-read Notifications and let the row speak.
   */
  | { kind: "closed" };

/** Mirrors packages/client's parser: `d.`/`w.` prefix + 43 base64url chars. */
const STATE_PATTERN = /^[dw]\.[A-Za-z0-9_-]{43}$/u;

function fragmentOf(rawUrl: string): Map<string, string> | undefined {
  const trimmed = rawUrl.trim();
  // Compare the scheme+path prefix case-insensitively; some OS launchers
  // normalize the scheme, none of them rewrite the fragment.
  const prefix = `${ASSIST_RETURN_URL}#`;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase())
    return undefined;
  const fields = new Map<string, string>();
  for (const pair of trimmed.slice(prefix.length).split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    try {
      fields.set(
        decodeURIComponent(pair.slice(0, separator)),
        decodeURIComponent(pair.slice(separator + 1).replaceAll("+", " "))
      );
    } catch {
      // A malformed escape makes the whole return link untrustworthy.
      return undefined;
    }
  }
  return fields;
}

function bounded(value: string | undefined, maxLength: number): string {
  return value && value.length > 0 && value.length <= maxLength ? value : "";
}

/**
 * Classify a `centraid://oauth/finish` return link. Unknown/incomplete links
 * are `closed` rather than a fake success — nothing is ever posted to the
 * gateway from a link we could not fully validate.
 */
export function parseAssistReturnUrl(rawUrl: string): ReconnectOutcome {
  const fields = fragmentOf(rawUrl);
  if (!fields) return { kind: "closed" };
  const state = bounded(fields.get("state"), 128);
  if (!STATE_PATTERN.test(state)) return { kind: "closed" };
  const error = bounded(fields.get("error"), 128);
  if (error)
    return error === "access_denied"
      ? { kind: "declined" }
      : { kind: "provider-error" };
  const code = bounded(fields.get("code"), 4096);
  const receipt = bounded(fields.get("receipt"), 1024);
  if (!code || !receipt) return { kind: "provider-error" };
  return { kind: "assist-handoff", handoff: { state, code, receipt } };
}

/** The subset of `WebBrowser.openAuthSessionAsync`'s result this module reads. */
export interface AuthSessionResultLike {
  type: string;
  url?: string;
}

/**
 * Turn an auth-session result into the action the screen should take. iOS
 * reports a user-closed session as `cancel`, Android as `dismiss`; both mean
 * the same thing here, so neither platform is special-cased.
 */
export function classifyAuthSession(
  result: AuthSessionResultLike
): ReconnectOutcome {
  if (result.type !== "success" || !result.url) return { kind: "closed" };
  return parseAssistReturnUrl(result.url);
}

/** Owner-facing copy for an outcome that must not be reported as success. */
export function reconnectFailureMessage(
  outcome: ReconnectOutcome
): string | undefined {
  switch (outcome.kind) {
    case "declined":
      return "You declined the consent screen — start Reconnect again.";
    case "provider-error":
      return "The provider could not finish authorizing — start Reconnect again.";
    case "assist-handoff":
    case "closed":
      return undefined;
  }
}
