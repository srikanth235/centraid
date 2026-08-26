import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

/** Lane-split turns (#731); omit `automationId` for the global feed. */
export async function listAutomationTurnsByLane(input: {
  automationId?: string;
  limit?: number;
  /** "member"/"recognition"; omit = combined feed. */
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
