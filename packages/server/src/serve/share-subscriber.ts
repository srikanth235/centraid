/*
 * THE AUDIENCE'S SUBSCRIBER (#929). Given a link, this pulls one grant-keyed
 * shape from its origin, fetches the bytes its manifest claims, and ingests it
 * through the seat door — the same `ingestShareShape` the loopback route takes,
 * so the two routes cannot drift.
 *
 * The seat PULLS. A notice from the origin carries no rows: what lands in this
 * vault is what this vault asked for, over the link that authorizes it.
 */

import { subscriberQuery } from "@centraid/core/protocol";
import type { ShareShapeFrame, VaultDb } from "@centraid/vault";

import {
  ingestPulledShape,
  PEER_REPLICA_BLOB_PATH,
  PEER_REPLICA_BOOTSTRAP_PATH,
} from "../routes/peer-replica-route.js";
import type { PeerReplicaPullOutcome } from "../routes/peer-replica-route.js";
import type { PeerDial, PeerDialRoute } from "./peer-link-client.js";

export interface PullShareShapeInput {
  dial: PeerDial;
  /** Where the ORIGIN gateway is. Address data, never identity. */
  route: PeerDialRoute;
  originVaultId: string;
  audienceVaultId: string;
  shapeId: string;
  seat: VaultDb;
  now: () => string;
}

function unreachable(detail: string): PeerReplicaPullOutcome {
  return { state: "unreachable", detail };
}

function frameOf(json: unknown): ShareShapeFrame | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const body = json as { state?: unknown; frame?: unknown };
  if (body.state !== "shape") return undefined;
  const frame = body.frame;
  if (frame === null || typeof frame !== "object") return undefined;
  const candidate = frame as Partial<ShareShapeFrame>;
  if (
    typeof candidate.shapeId !== "string" ||
    typeof candidate.grantId !== "string" ||
    typeof candidate.originVaultId !== "string" ||
    typeof candidate.audienceVaultId !== "string" ||
    candidate.closure === undefined ||
    !Array.isArray(candidate.rowVersions)
  )
    return undefined;
  return frame as ShareShapeFrame;
}

/**
 * Bytes the seat does not already hold, one bounded chunk per request. Content
 * addressing is the integrity check: a chunk stream that did not hash to the
 * sha the manifest named is not written, so a peer cannot swap bytes under a
 * content address the audience already trusts.
 */
async function pullBlobs(
  input: PullShareShapeInput,
  frame: ShareShapeFrame
): Promise<string | undefined> {
  const store = input.seat.blobs.local;
  const endpointTicket = input.dial.endpointTicketFor(
    input.route.endpointId,
    input.route.relayHints
  );
  for (const blob of frame.closure.blobs) {
    if (store.hasSync(blob.sha256)) continue;
    const chunks: Buffer[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const query = subscriberQuery({
        originVaultId: input.originVaultId,
        audienceVaultId: input.audienceVaultId,
        shapeId: input.shapeId,
      });
      // oxlint-disable-next-line no-await-in-loop -- (#929) each chunk's offset is the previous chunk's end, so the pull is sequential by construction
      const response = await input.dial.request({
        endpointTicket,
        method: "GET",
        target: `${PEER_REPLICA_BLOB_PATH}?${query}&sha256=${encodeURIComponent(blob.sha256)}&offset=${offset}`,
      });
      const body = response.json as {
        state?: string;
        total?: number;
        base64?: string;
      };
      if (response.status !== 200 || body.state !== "chunk")
        return `the origin would not serve ${blob.sha256}`;
      const bytes = Buffer.from(body.base64 ?? "", "base64");
      if (bytes.byteLength === 0) return `empty chunk for ${blob.sha256}`;
      chunks.push(bytes);
      total = body.total ?? 0;
      offset += bytes.byteLength;
    }
    // `ingestSync` re-hashes and refuses a mismatch, so a swapped byte cannot
    // land under a content address this vault already trusts.
    const ingested = input.seat.blobs.ingestSync(Buffer.concat(chunks));
    if (ingested.sha256 !== blob.sha256)
      return `bytes for ${blob.sha256} did not hash to their content address`;
  }
  return undefined;
}

/** Bootstrap or refresh one shape. `unreachable` never leaves a partial seat:
 *  the ingest is one transaction, and the bytes precede it. */
export async function pullShareShape(
  input: PullShareShapeInput
): Promise<PeerReplicaPullOutcome> {
  const endpointTicket = input.dial.endpointTicketFor(
    input.route.endpointId,
    input.route.relayHints
  );
  const query = subscriberQuery({
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    shapeId: input.shapeId,
  });
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket,
      method: "GET",
      target: `${PEER_REPLICA_BOOTSTRAP_PATH}?${query}`,
    });
  } catch (error) {
    return unreachable(
      error instanceof Error ? error.message : "the origin could not be dialled"
    );
  }
  if (response.status !== 200)
    return unreachable(`the origin answered ${response.status}`);
  const frame = frameOf(response.json);
  if (!frame) return unreachable("the origin sent no usable shape");
  if (
    frame.shapeId !== input.shapeId ||
    frame.originVaultId !== input.originVaultId ||
    frame.audienceVaultId !== input.audienceVaultId
  )
    return unreachable("the origin sent a shape this seat did not ask for");
  const blobFailure = await pullBlobs(input, frame);
  if (blobFailure) return unreachable(blobFailure);
  return ingestPulledShape(input.seat, frame, {
    audienceVaultId: input.audienceVaultId,
    now: input.now(),
  });
}
