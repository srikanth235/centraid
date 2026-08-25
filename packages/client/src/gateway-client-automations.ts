/*
 * Renderer-side client for the automation-turns lane split (#731).
 *
 * `gateway-client.ts`'s `listAutomationTurns` fetches one combined,
 * `boundedLimit`-wide window of every automation turn — member automations
 * and the collapsed "recognition" system lane together. A large photo
 * import fires the recognition automations once per photo, so that single
 * window could fill entirely with recognition runs and leave a member's own
 * "Recent activity" empty. `listAutomationTurnsByLane` adds the
 * `?systemLane=` param the route (`packages/server/src/routes/
 * automations-routes.ts`) uses to fetch each lane as its own SQL-filtered,
 * independently-bounded query, so the two callers in `automationsData.ts`
 * each get their own window.
 *
 * Split into its own module per the convention
 * `gateway-client-connections.ts` documents — new automation calls don't
 * need to grow `gateway-client.ts` further — and re-exported from the
 * barrel like every sibling, so callers import it from `gateway-client.js`
 * and a suite that mocks the barrel never loads this module's real
 * `gateway-client-core.js` import chain.
 */

import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

/** Native automation turns, newest-first, scoped to one lane. Omit `automationId` for the global feed. */
export async function listAutomationTurnsByLane(input: {
  automationId?: string;
  limit?: number;
  /** "member" excludes the built-in recognition automations; "recognition" is only those. Omit for the combined feed (`listAutomationTurns`'s old behavior). */
  systemLane?: "member" | "recognition";
}): Promise<CentraidAutomationTurnRecord[]> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.automationId) params.set("ref", input.automationId);
  params.set("limit", String(input.limit ?? 50));
  if (input.systemLane) params.set("systemLane", input.systemLane);
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/turns?${params.toString()}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ turns: CentraidAutomationTurnRecord[] }>(
    res,
    "list turns"
  );
  return out.turns ?? [];
}
