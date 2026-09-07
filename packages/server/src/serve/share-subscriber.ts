/*
 * THE AUDIENCE'S SUBSCRIBER (#929). Given a link, this pulls one grant-keyed
 * shape from its origin, fetches the bytes its manifest claims, and ingests it
 * through the seat door — the same `ingestShareShape` the loopback route takes,
 * so the two routes cannot drift.
 *
 * The seat PULLS. A notice from the origin carries no rows: what lands in this
 * vault is what this vault asked for, over the link that authorizes it.
 */

import { shareShapeGrantId, subscriberQuery } from "@centraid/core/protocol";
import { readSubscription } from "@centraid/vault";
import type { ShareShapeFrame, ShareTailFrame, VaultDb } from "@centraid/vault";

import {
  ingestPulledShape,
  ingestPulledTail,
  PEER_REPLICA_BLOB_PATH,
  PEER_REPLICA_BOOTSTRAP_PATH,
  PEER_REPLICA_TAIL_PATH,
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
  manifest: readonly { sha256: string }[]
): Promise<string | undefined> {
  const store = input.seat.blobs.local;
  const endpointTicket = input.dial.endpointTicketFor(
    input.route.endpointId,
    input.route.relayHints
  );
  for (const blob of manifest) {
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

function tailOf(json: unknown): ShareTailFrame | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const body = json as { state?: unknown; frame?: unknown };
  if (body.state !== "tail") return undefined;
  const frame = body.frame;
  if (frame === null || typeof frame !== "object") return undefined;
  const candidate = frame as Partial<ShareTailFrame>;
  if (
    typeof candidate.authorityId !== "string" ||
    typeof candidate.originVaultId !== "string" ||
    typeof candidate.audienceVaultId !== "string" ||
    candidate.outputs === undefined ||
    !Array.isArray(candidate.blobs)
  )
    return undefined;
  return frame as ShareTailFrame;
}

/**
 * THE PREDICATE PULL (#996, R10). The seat asks the origin what changed for
 * this grant since the cursor IT holds, fetches the bytes the answer's
 * manifest names, and applies the three outputs — enter, update, leave — as
 * rows, re-keyed through lineage.
 *
 * `undefined` means "this grant is not servable as rows" — the origin said
 * `snapshot`, and the caller falls back to the frame door. That fallback is
 * the transport invariant, not a rung: for one wave the two doors stand side
 * by side, and the frame door goes when the tail serves every subscription.
 */
export async function pullShareTail(
  input: PullShareShapeInput
): Promise<PeerReplicaPullOutcome | undefined> {
  const authorityId = shareShapeGrantId(input.shapeId);
  if (!authorityId) return undefined;
  const standing = readSubscription(
    input.seat.vault,
    authorityId,
    input.audienceVaultId
  );
  const endpointTicket = input.dial.endpointTicketFor(
    input.route.endpointId,
    input.route.relayHints
  );
  const query = subscriberQuery({
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    shapeId: input.shapeId,
  });
  const cursor =
    standing?.cursor.epoch === null || standing === undefined
      ? ""
      : `&epoch=${encodeURIComponent(standing.cursor.epoch)}&seq=${standing.cursor.seq}`;
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket,
      method: "GET",
      target: `${PEER_REPLICA_TAIL_PATH}?${query}${cursor}`,
    });
  } catch (error) {
    return unreachable(
      error instanceof Error ? error.message : "the origin could not be dialled"
    );
  }
  if (response.status !== 200) return undefined;
  const body = response.json as { state?: unknown };
  // The origin says this grant needs the closure snapshot; take the other door.
  if (body.state === "snapshot") return undefined;
  const frame = tailOf(response.json);
  if (!frame) return unreachable("the origin sent no usable tail");
  if (
    frame.authorityId !== authorityId ||
    frame.originVaultId !== input.originVaultId ||
    frame.audienceVaultId !== input.audienceVaultId
  )
    return unreachable("the origin sent a tail this seat did not ask for");
  const blobFailure = await pullBlobs(input, frame.blobs);
  if (blobFailure) return unreachable(blobFailure);
  return ingestPulledTail(input.seat, frame, {
    audienceVaultId: input.audienceVaultId,
    now: input.now(),
  });
}

/** Bootstrap or refresh one shape. `unreachable` never leaves a partial seat:
 *  the ingest is one transaction, and the bytes precede it. */
export async function pullShareShape(
  input: PullShareShapeInput
): Promise<PeerReplicaPullOutcome> {
  const tail = await pullShareTail(input);
  if (tail !== undefined) return tail;
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
  const blobFailure = await pullBlobs(input, frame.closure.blobs);
  if (blobFailure) return unreachable(blobFailure);
  return ingestPulledShape(input.seat, frame, {
    audienceVaultId: input.audienceVaultId,
    now: input.now(),
  });
}
