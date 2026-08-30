// Analytics window pref (#765): a MEMBER preference on the gateway, read and
// written under the one key both seats share (#883).

import {
  INSIGHTS_WINDOW_PREF_KEY,
  isInsightsWindow,
} from "@centraid/client/insights-copy";

import { apiHeaders, fetchJson, requireGatewayBase } from "../../lib/gateway";

/** Never throws: an unreadable pref opens on the default. */
export async function readWindowPref(): Promise<number | undefined> {
  try {
    const base = await requireGatewayBase();
    const result = await fetchJson<{ prefs?: Record<string, unknown> }>(
      `${base}/_centraid-user/prefs`,
      { headers: apiHeaders(), method: "GET" }
    );
    const saved = result.prefs?.[INSIGHTS_WINDOW_PREF_KEY];
    return isInsightsWindow(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Fire-and-forget: failure must never block or undo the view. */
export async function writeWindowPref(windowDays: number): Promise<void> {
  try {
    const base = await requireGatewayBase();
    await fetchJson(`${base}/_centraid-user/prefs`, {
      body: JSON.stringify({
        patch: { [INSIGHTS_WINDOW_PREF_KEY]: windowDays },
      }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "PUT",
    });
  } catch {
    // A pref note must not outrank the page.
  }
}
