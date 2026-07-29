import { ROUTES } from "@centraid/protocol";

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

/** Shared foreground/background transport for the durable placement outbox. */
export async function postPlacement(
  baseUrl: string,
  input: PlacementIntent
): Promise<PlacementRecord> {
  const response = await fetch(new URL(ROUTES.gatewayPlacements, baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as
    | PlacementRecord
    | { message?: string };
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
  return body as PlacementRecord;
}
