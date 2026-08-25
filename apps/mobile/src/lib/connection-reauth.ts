/**
 * Finishing a `needs-auth` connection from the phone (#647). NEVER the PWA
 * shape: `surface:"web"` binds the handoff where it cannot be redeemed, and the
 * SYSTEM browser suspends this app, killing the loopback proxy BYO needs — use
 * an in-app session with `surface:"desktop"`. A third value is a gateway change.
 */

export const ASSIST_RETURN_URL = "centraid://oauth/finish";

export const MOBILE_AUTHORIZE_SURFACE = "desktop";

export interface AssistHandoff {
  state: string;
  code: string;
  receipt: string;
}

export type ReconnectOutcome =
  | { kind: "assist-handoff"; handoff: AssistHandoff }
  | { kind: "declined" }
  | { kind: "provider-error" }
  /** Owner backed out, or BYO finished at the gateway's callback —
   * indistinguishable on purpose; re-read Notifications. */
  | { kind: "closed" };

const STATE_PATTERN = /^[dw]\.[A-Za-z0-9_-]{43}$/u;

function fragmentOf(rawUrl: string): Map<string, string> | undefined {
  const trimmed = rawUrl.trim();
  // Some OS launchers normalize the scheme; none rewrite the fragment.
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
      // A malformed escape makes the whole link untrustworthy.
      return undefined;
    }
  }
  return fields;
}

function bounded(value: string | undefined, maxLength: number): string {
  return value && value.length > 0 && value.length <= maxLength ? value : "";
}

/** Incomplete links are `closed`, never a fake success. */
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

export interface AuthSessionResultLike {
  type: string;
  url?: string;
}

/** iOS says `cancel`, Android `dismiss`; no platform branch belongs here. */
export function classifyAuthSession(
  result: AuthSessionResultLike
): ReconnectOutcome {
  if (result.type !== "success" || !result.url) return { kind: "closed" };
  return parseAssistReturnUrl(result.url);
}

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
