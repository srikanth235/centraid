// Analytics window pref (#765): a MEMBER preference on the gateway under the
// desktop key — one fact shared by phone and desktop.

import { apiHeaders, fetchJson, requireGatewayBase } from "../../lib/gateway";
import { isWindowDays } from "./insights-model";

/** Changing this key forks desktop and phone. */
export const WINDOW_PREF_KEY = "insights.windowDays";

/** Never throws: an unreadable pref opens on the default. */
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

/** Fire-and-forget: failure must never block or undo the view. */
export async function writeWindowPref(windowDays: number): Promise<void> {
  try {
    const base = await requireGatewayBase();
    await fetchJson(`${base}/_centraid-user/prefs`, {
      body: JSON.stringify({ patch: { [WINDOW_PREF_KEY]: windowDays } }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "PUT",
    });
  } catch {
    // A pref note must not outrank the page.
  }
}
