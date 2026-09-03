import { ROUTES } from "@centraid/core/protocol";

import { authHeader } from "../gateway";
import type { PlacementIntent, PlacementRecord } from "./multi-vault-reader";

export class PlacementSubmissionError extends Error {
  constructor(
    message: string,
    readonly placementStatus: "denied" | "failed"
  ) {
    super(message);
    this.name = "PlacementSubmissionError";
  }
}

function toPlacementStatus(status: unknown): PlacementRecord["status"] {
  if (status === "completed" || status === "established") return "executed";
  return status === "queued" ||
    status === "in-flight" ||
    status === "parked" ||
    status === "denied"
    ? status
    : "failed";
}

interface EdgeWire {
  edgeId: string;
  status: string;
  itemIds?: string[];
  reason?: string;
  createdAt?: string;
  updatedAt?: string;
}

function toPlacementRecord(
  edge: EdgeWire,
  input: PlacementIntent
): PlacementRecord {
  const now = new Date().toISOString();
  return {
    ...input,
    status: toPlacementStatus(edge.status),
    ...(edge.reason ? { reason: edge.reason } : {}),
    createdAt: edge.createdAt ?? now,
    updatedAt: edge.updatedAt ?? now,
  };
}

export async function postPlacement(
  baseUrl: string,
  input: PlacementIntent
): Promise<PlacementRecord> {
  const response = await fetch(new URL(ROUTES.gatewayEdges, baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      edgeId: input.linkToken,
      originVaultId: input.sourceVaultId,
      audienceVaultId: input.targetVaultId,
      mode: "snapshot",
      kind: input.kind,
      itemType: input.itemType,
      itemIds: [input.itemId],
      verbs: "read",
    }),
  });
  const body = (await response.json()) as EdgeWire | { message?: string };
  if (response.status >= 500) {
    throw new Error(`Placement gateway unavailable (${response.status})`);
  }
  if (!response.ok) {
    throw new PlacementSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Placement failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  return toPlacementRecord(body as EdgeWire, input);
}

export interface CommonsIntent {
  containerType: string;
  containerId: string;
  sourceVaultId: string;
  members: readonly {
    partyId?: string;
    vaultId?: string;
    capability: "read" | "read+write";
  }[];
  circleId?: string;
}

export interface CommonsRecord {
  grantId: string;
  circleId: string;
  state: "active" | "invited";
  currentSizeBytes: number;
  maxSizeBytes?: number | null;
  claims: Array<{ partyId: string; claimToken: string }>;
}

export interface CommonsResident {
  grantId: string;
  itemType: string;
  itemId: string;
  originItemId: string;
}

export async function listCommonsResidents(
  baseUrl: string,
  actorVaultId: string
): Promise<CommonsResident[]> {
  const query = new URLSearchParams({ actorVaultId });
  const response = await fetch(
    new URL(`${ROUTES.gatewayCommons}/resident?${query.toString()}`, baseUrl),
    { headers: authHeader() }
  );
  if (!response.ok)
    throw new Error(`list resident commons items failed (${response.status})`);
  const out = (await response.json()) as { items?: CommonsResident[] };
  return out.items ?? [];
}

export async function retainCommonsItem(
  baseUrl: string,
  input: { actorVaultId: string; itemType: string; itemId: string }
): Promise<{ retained: boolean; grantIds: string[] }> {
  const response = await fetch(
    new URL(`${ROUTES.gatewayCommons}/retain`, baseUrl),
    {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!response.ok)
    throw new Error(`save commons item failed (${response.status})`);
  return (await response.json()) as {
    retained: boolean;
    grantIds: string[];
  };
}

export async function postCommons(
  baseUrl: string,
  input: CommonsIntent
): Promise<CommonsRecord> {
  const response = await fetch(new URL(ROUTES.gatewayCommons, baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      originVaultId: input.sourceVaultId,
      containerType: input.containerType,
      containerId: input.containerId,
      members: input.members,
      ...(input.circleId ? { circleId: input.circleId } : {}),
    }),
  });
  const body = (await response.json()) as CommonsRecord | { message?: string };
  if (response.status >= 500) {
    throw new Error(`Sharing gateway unavailable (${response.status})`);
  }
  if (!response.ok) {
    throw new PlacementSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Share failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  return body as CommonsRecord;
}
