// Renderer-side transport for the gateway's edge/ask surface (#726 P2/P4 —
// `packages/gateway/src/routes/edges-routes.ts` and `edge-answer-routes.ts`),
// mirroring `links-transport.ts`'s shape. Mobile's own People/Sharing screen
// data source, independent of any one app mount.
import { ROUTES } from "@centraid/protocol";

import { authHeader } from "../gateway";

export type EdgeStatus =
  | "queued"
  | "in-flight"
  | "established"
  | "parked"
  | "denied"
  | "revoked"
  | "completed"
  | "failed";

export interface GatewayEdge {
  edgeId: string;
  kind: "add" | "move";
  mode: "snapshot";
  itemType: string;
  itemIds?: string[];
  originVaultId: string;
  audienceVaultId: string;
  status: EdgeStatus;
  reason?: string;
  accessReceiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingEdge {
  edgeId: string;
  peerVaultId: string;
  localVaultId: string;
  itemType: string;
  itemCount: number;
  createdAt: string;
}

export async function listEdges(baseUrl: string): Promise<GatewayEdge[]> {
  const response = await fetch(new URL(ROUTES.gatewayEdges, baseUrl), {
    headers: authHeader(),
  });
  if (!response.ok) throw new Error(`list edges failed (${response.status})`);
  const out = (await response.json()) as { edges: GatewayEdge[] };
  return out.edges ?? [];
}

export async function listPendingEdges(
  baseUrl: string
): Promise<PendingEdge[]> {
  const response = await fetch(
    new URL(`${ROUTES.gatewayEdges}/pending`, baseUrl),
    { headers: authHeader() }
  );
  if (!response.ok)
    throw new Error(`list pending edges failed (${response.status})`);
  const out = (await response.json()) as { pending: PendingEdge[] };
  return out.pending ?? [];
}

export async function answerPendingEdge(
  baseUrl: string,
  edgeId: string,
  decision: "accept" | "refuse"
): Promise<{ edgeId: string; decision: string }> {
  const response = await fetch(
    new URL(
      `${ROUTES.gatewayEdges}/${encodeURIComponent(edgeId)}/answer`,
      baseUrl
    ),
    {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }
  );
  if (!response.ok)
    throw new Error(`answer pending edge failed (${response.status})`);
  return (await response.json()) as { edgeId: string; decision: string };
}
