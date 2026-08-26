// Renderer-side transport for the gateway's placement surface (#726 —
// `packages/server/src/routes/edges-routes.ts`), mirroring
// `links-transport.ts`'s shape. Mobile's own People/Sharing screen data
// source, independent of any one app mount.
//
// An edge is a copy between two vaults ONE PERSON owns. There is no D9 ask
// surface here — no `GET …/edges/pending`, no `POST …/edges/:id/answer`
// (#825, ruling G-copy); sharing with another person is a standing grant, read
// and written through `src/kit/share/grants-transport.ts`.
import { ROUTES } from "@centraid/core/protocol";

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

export async function listEdges(baseUrl: string): Promise<GatewayEdge[]> {
  const response = await fetch(new URL(ROUTES.gatewayEdges, baseUrl), {
    headers: authHeader(),
  });
  if (!response.ok) throw new Error(`list edges failed (${response.status})`);
  const out = (await response.json()) as { edges: GatewayEdge[] };
  return out.edges ?? [];
}
