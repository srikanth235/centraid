import { describe, expect, test } from "vitest";

import {
  ASSIST_RETURN_URL,
  MOBILE_AUTHORIZE_SURFACE,
  classifyAuthSession,
  parseAssistReturnUrl,
  reconnectFailureMessage,
} from "./connection-reauth";

const STATE = `d.${"A".repeat(43)}`;

function returnUrl(fragment: Record<string, string>): string {
  const pairs = Object.entries(fragment)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${ASSIST_RETURN_URL}#${pairs}`;
}

describe("mobile connection re-authorization", () => {
  test("asks for the deep-link return surface, never the PWA one", () => {
    // `web` sends the Assist callback to app.centraid.dev, which cannot hand
    // anything back to this app and is bound to a different client session.
    expect(MOBILE_AUTHORIZE_SURFACE).toBe("desktop");
    expect(ASSIST_RETURN_URL).toBe("centraid://oauth/finish");
  });

  test("parses the Assist courier tuple out of the return link", () => {
    expect(
      parseAssistReturnUrl(
        returnUrl({ code: "4/auth-code", state: STATE, receipt: "r-1" })
      )
    ).toStrictEqual({
      kind: "assist-handoff",
      handoff: { state: STATE, code: "4/auth-code", receipt: "r-1" },
    });
  });

  test("separates a declined consent screen from a provider error", () => {
    expect(
      parseAssistReturnUrl(returnUrl({ state: STATE, error: "access_denied" }))
    ).toStrictEqual({ kind: "declined" });
    expect(
      parseAssistReturnUrl(returnUrl({ state: STATE, error: "server_error" }))
    ).toStrictEqual({ kind: "provider-error" });
    expect(reconnectFailureMessage({ kind: "declined" })).toContain("declined");
    expect(reconnectFailureMessage({ kind: "closed" })).toBeUndefined();
  });

  test("refuses to post a handoff from a link it cannot fully validate", () => {
    // A foreign scheme, a malformed state, and a code without its receipt are
    // all "closed"/"provider-error" — never a handoff.
    expect(
      parseAssistReturnUrl(
        `https://app.centraid.dev/oauth/finish#code=c&state=${STATE}&receipt=r`
      )
    ).toStrictEqual({ kind: "closed" });
    expect(
      parseAssistReturnUrl(
        returnUrl({ code: "c", state: "nope", receipt: "r" })
      )
    ).toStrictEqual({ kind: "closed" });
    expect(
      parseAssistReturnUrl(returnUrl({ code: "c", state: STATE }))
    ).toStrictEqual({ kind: "provider-error" });
  });

  test("a browser the owner simply closed asks only for a refresh", () => {
    // iOS says `cancel`, Android says `dismiss`, and a BYO ceremony that
    // finished at the gateway's own callback page looks identical from here —
    // all three mean "re-read the Notifications", never "claim success".
    expect(classifyAuthSession({ type: "cancel" })).toStrictEqual({
      kind: "closed",
    });
    expect(classifyAuthSession({ type: "dismiss" })).toStrictEqual({
      kind: "closed",
    });
    expect(classifyAuthSession({ type: "success" })).toStrictEqual({
      kind: "closed",
    });
  });

  test("a successful session carries the handoff through unchanged", () => {
    expect(
      classifyAuthSession({
        type: "success",
        url: returnUrl({ code: "c", state: STATE, receipt: "r" }),
      })
    ).toStrictEqual({
      kind: "assist-handoff",
      handoff: { state: STATE, code: "c", receipt: "r" },
    });
  });
});
