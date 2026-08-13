// Where the Analytics window lives between sessions (#765).
//
// It is a MEMBER preference on the gateway, not phone-local state, and it is
// stored under the key the desktop leg uses (`insights.windowDays`, see
// `packages/client/src/react/shell/routes/InsightsRoute.tsx`) against the same
// `/_centraid-user/prefs` store. One key, one meaning: a member who sets 7 days
// on the desktop opens the phone on 7 days, because it is the same fact.
//
// This composes the gateway module's own primitives (`requireGatewayBase`,
// `apiHeaders`, `fetchJson`) exactly as `lib/assistant.ts` does for its
// harness prefs; it is a two-call read/write, not a second HTTP client.

import { apiHeaders, fetchJson, requireGatewayBase } from "../../lib/gateway";
import { isWindowDays } from "./insights-model";

/** The shared key. Changing it here would silently fork the two surfaces. */
export const WINDOW_PREF_KEY = "insights.windowDays";

/**
 * The stored window, or `undefined` when there is none this page can honour.
 *
 * Never throws: a preference that cannot be read is not a reason to fail the
 * page, it is a reason to open on the default.
 */
export async function readWindowPref(): Promise<number | undefined> {
  try {
    const base = await requireGatewayBase();
    const result = await fetchJson<{ prefs?: Record<string, unknown> }>(
      `${base}/_centraid-user/prefs`,
      { headers: apiHeaders(), method: "GET" }
    );
    const saved = result.prefs?.[WINDOW_PREF_KEY];
    return isWindowDays(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remember the window the member is looking at.
 *
 * Fire and forget by contract: the window is a preference, not a commit, and a
 * failed write must never block or undo the view the reader just asked for.
 */
export async function writeWindowPref(windowDays: number): Promise<void> {
  try {
    const base = await requireGatewayBase();
    await fetchJson(`${base}/_centraid-user/prefs`, {
      body: JSON.stringify({ patch: { [WINDOW_PREF_KEY]: windowDays } }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "PUT",
    });
  } catch {
    // Nothing to say: the page is already showing the window that failed to
    // persist, and a note about a preference would outrank the page's content.
  }
}
