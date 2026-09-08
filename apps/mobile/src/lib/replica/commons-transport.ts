// SHARING, OVER HTTP, WITH NO OUTBOX BEHIND IT.
//
// This is the surviving half of `placement-transport.ts` (#996 wave 3). The
// other half was the cross-vault PLACEMENT plane — its own durable outbox, its
// own status vocabulary, its own pending rows beside the intent outbox's — and
// it went with the `crossVaultPlacements` capability that described it.
//
// Sharing is not a plane. A share is a predicate over the vault (wave 7), and
// what is left here is the three calls that ask the gateway to compile one:
// list what a member is already holding from someone else's vault, keep one of
// those, and offer a container to people. None of them queues anything on this
// phone, so none of them belongs to a session.

import { ROUTES } from "@centraid/core/protocol";

import { authHeader } from "../gateway";

/** A share the gateway refused, with which of the two refusals it was. */
export class CommonsSubmissionError extends Error {
  constructor(
    message: string,
    readonly shareStatus: "denied" | "failed"
  ) {
    super(message);
    this.name = "CommonsSubmissionError";
  }
}

export interface CommonsIntent {
  containerType: string;
  containerId: string;
  sourceVaultId: string;
  members: readonly {
    /** Required when the destination is a linked, unmounted peer. */
    partyId?: string;
    /** Absent while this is an invitation waiting for the person to join. */
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

/** Compile a shared container into each joined member's vault. */
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
    throw new CommonsSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Share failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  return body as CommonsRecord;
}
