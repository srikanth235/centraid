/*
 * Renderer client for snapshot edges (#731). SAME-OWNER ONLY since #825
 * (ruling G-copy): edges copy between two vaults ONE PERSON owns — cross-owner
 * give retired (`cross_owner_give_retired`); other-people sharing is a
 * standing GRANT on `/centraid/_vault/grants`, delivered as a subscription
 * (#929).
 */

import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

const EDGES_PATH = "/centraid/_gateway/edges";

export type EdgeMode = "snapshot";
export type EdgeKind = "add" | "move";
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
  kind: EdgeKind;
  mode: EdgeMode;
  itemType: string;
  itemIds?: string[];
  originVaultId: string;
  audienceVaultId: string;
  verbs: string;
  status: EdgeStatus;
  reason?: string;
  accessReceiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export async function listGatewayEdges(): Promise<GatewayEdge[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, EDGES_PATH, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ edges: GatewayEdge[] }>(res, "list edges");
  return out.edges ?? [];
}
