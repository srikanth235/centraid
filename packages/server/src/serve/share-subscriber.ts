/*
 * THE AUDIENCE'S SUBSCRIBER (#929). Given a link, this pulls one grant-keyed
 * shape from its origin, fetches the bytes its manifest claims, and ingests it
 * through the seat door — the same `ingestShareShape` the loopback route takes,
 * so the two routes cannot drift.
 *
 * The seat PULLS. A notice from the origin carries no rows: what lands in this
 * vault is what this vault asked for, over the link that authorizes it.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";

import { shareShapeGrantId, subscriberQuery } from "@centraid/core/protocol";
import { readSubscription } from "@centraid/vault";
import type { ShareTailFrame, VaultDb } from "@centraid/vault";

import {
  ingestPulledTail,
  PEER_REPLICA_BLOB_PATH,
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

/**
 * A CHUNK AT A TIME, AND NEVER MORE THAN THE MANIFEST DECLARED (#1014, V11).
 *
 * The manifest entry's `size` is what the origin judged the grant's ceiling
 * against, so it is the audience's cap too: a `total` larger than it, or a
 * stream that runs past it, is the origin contradicting the closure it served
 * and the pull stops before the next byte is asked for. Without this the seat
 * concatenated whatever arrived, and one shared video was an OOM on both ends.
 *
 * Bytes go to a staging file as they arrive rather than into an array of
 * buffers, and the content address is computed over the stream, so a blob only
 * ever costs one chunk of memory. A store with no staging seam (the memory
 * tier) keeps the buffered path — bounded by the same cap.
 */
function stagedWrite(
  blobs: VaultDb["blobs"],
  sha256: string
): { path: string; write: (bytes: Buffer) => void; close: () => void } | null {
  const temp = blobs.stagingPathSync(sha256);
  if (temp === null) return null;
  const fd = openSync(temp, "w", 0o600);
  let open = true;
  return {
    path: temp,
    write: (bytes) => {
      writeSync(fd, bytes);
    },
    close: () => {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

async function pullBlob(
  input: PullShareShapeInput,
  blob: { sha256: string; size: number },
  endpointTicket: ReturnType<PeerDial["endpointTicketFor"]>
): Promise<string | undefined> {
  // BEFORE THE FIRST BYTE: the manifest's own declaration is the cap.
  if (!Number.isSafeInteger(blob.size) || blob.size < 0)
    return `the manifest declared no usable size for ${blob.sha256}`;
  const staged = stagedWrite(input.seat.blobs, blob.sha256);
  const buffered: Buffer[] = [];
  const digest = createHash("sha256");
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  try {
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
      total = body.total ?? 0;
      if (total > blob.size)
        return `the origin offered ${total} bytes for ${blob.sha256}, past the ${blob.size} its manifest declared`;
      const bytes = Buffer.from(body.base64 ?? "", "base64");
      if (bytes.byteLength === 0) return `empty chunk for ${blob.sha256}`;
      // WHILE STREAMING: the same cap again, because `total` is the origin's
      // claim and the bytes are what it actually sent.
      if (offset + bytes.byteLength > blob.size)
        return `the origin sent past the ${blob.size} bytes it declared for ${blob.sha256}`;
      digest.update(bytes);
      if (staged) staged.write(bytes);
      else buffered.push(bytes);
      offset += bytes.byteLength;
    }
    // Content addressing is the integrity check: bytes that did not hash to
    // the sha the manifest named are never adopted, so a peer cannot swap
    // them under a content address this vault already trusts.
    if (digest.digest("hex") !== blob.sha256)
      return `bytes for ${blob.sha256} did not hash to their content address`;
    if (staged) {
      staged.close();
      input.seat.blobs.adoptStagedSync(blob.sha256, staged.path, offset);
      return undefined;
    }
    input.seat.blobs.ingestSync(Buffer.concat(buffered));
    return undefined;
  } finally {
    if (staged) {
      staged.close();
      // Adoption renamed it away; anything left is a pull that failed.
      rmSync(staged.path, { force: true });
    }
  }
}

/** Bytes the seat does not already hold, one bounded chunk per request. */
async function pullBlobs(
  input: PullShareShapeInput,
  manifest: readonly { sha256: string; size: number }[]
): Promise<string | undefined> {
  const store = input.seat.blobs.local;
  const endpointTicket = input.dial.endpointTicketFor(
    input.route.endpointId,
    input.route.relayHints
  );
  for (const blob of manifest) {
    if (store.hasSync(blob.sha256)) continue;
    // oxlint-disable-next-line no-await-in-loop -- (#929) one blob at a time is the point: the seat holds one chunk, never a library
    const failure = await pullBlob(input, blob, endpointTicket);
    if (failure) return failure;
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
 * `undefined` means the origin cannot serve this grant as rows and said so
 * (`unsupported`). There is no second door to fall back to — the frame path is
 * deleted — so the caller reports it rather than pretending a delivery.
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
  if (body.state === "unsupported") return undefined;
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
