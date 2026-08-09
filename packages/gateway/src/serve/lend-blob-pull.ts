/*
 * Filling the borrowed CAS (#726 P4, closing the gap the core lend agent
 * flagged): a live edge's rows can name a thumbnail or a poster without the
 * bytes ever arriving, and an empty CAS beside a full store is a lent album
 * that never paints. This is the puller that makes them arrive.
 *
 * Remote origin: the SAME ranged, resumable, sha-verified pull
 * `peer-blob-pull.ts` runs for a give's originals — same frame
 * (`/centraid/_peer/blob/chunk`), same authorization (`hasGivenEdge`, already
 * true for an established live edge's `share_edges` row) — writing into the
 * BORROWED CAS instead of the vault's. Co-hosted origin: no wire at all, just
 * a local file read, per D3 ("locality is routing, not semantics").
 *
 * Only PINNED rungs (thumb/poster) are pulled proactively — that is the
 * viewer seat's actual duty (`borrowed-cas.ts`). A preview is reclaimed FIRST
 * under pressure and must not be chased right back; an original is never a
 * duty at all. Both stay reachable on demand by a future read path, out of
 * scope here.
 *
 * The per-link byte budget (#726 P4 item 8) is enforced here, not by
 * refusing the edge: once pulling a blob would put this store's RESIDENT
 * total over budget, remaining pending blobs are PARKED — left exactly where
 * they were, custody untouched — rather than errored. The check is live and
 * stateless (current resident bytes vs. a constant), so nothing here needs
 * to remember a budget was hit; the very next call simply sees room again if
 * something freed it in the meantime.
 */

import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, rmSync, statSync } from "node:fs";

import type { LocalBlobStore } from "@centraid/vault";

import type { BorrowedCas } from "./borrowed-cas.js";
import { custodyForRung } from "./borrowed-cas.js";
import type { BorrowedBlobRef, BorrowedStore } from "./borrowed-store.js";
import type { LendEdgeIdentity } from "./lend-audience.js";
import { acceptLease, parseLease } from "./lend-lease.js";
import { PEER_BLOB_CHUNK_PATH } from "./peer-blob-route-path.js";
import type { PeerDial, PeerDialRoute } from "./peer-edge-give-client.js";

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** A generous default — thumbnails and posters are small; this is headroom
 *  for a large lent library, not a tight cap. A knob, not a policy: callers
 *  may override it (tests do, to exercise parking without allocating 20GB). */
export const DEFAULT_BORROWED_LINK_BYTE_BUDGET = 20 * 1024 * 1024 * 1024;

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Pinned blobs a shape's rows name that are not yet resident. Bounded by the
 *  caller — this is a read, not a queue table, so "pending" is recomputed
 *  fresh every tick from whatever rows have landed so far. */
export function pendingPinnedBlobs(
  store: BorrowedStore,
  shapeId: string,
  cas: BorrowedCas
): BorrowedBlobRef[] {
  return store
    .blobsOfShape(shapeId)
    .filter(
      (blob) =>
        blob.custodyState === "at-origin" &&
        custodyForRung(blob.rung) === "pinned" &&
        !cas.has(blob.sha256)
    );
}

/**
 * Pull one blob over the peer plane, ranged and resumable — never throws for
 * a network condition, only for a truly unexpected local failure (out of
 * disk, etc.), exactly like `peer-blob-pull.ts::pullOne`.
 */
async function pullOne(
  cas: BorrowedCas,
  store: BorrowedStore,
  shapeId: string,
  dial: PeerDial,
  route: PeerDialRoute,
  identity: LendEdgeIdentity,
  edgeId: string,
  blob: BorrowedBlobRef,
  chunkBytes: number
): Promise<"done" | "pending" | "failed"> {
  if (cas.has(blob.sha256)) return "done";
  const tempPath = cas.promotionTempPathSync(blob.sha256);
  if (blob.byteSize === 0) appendFileSync(tempPath, Buffer.alloc(0));
  for (;;) {
    const have = fileSizeOf(tempPath);
    if (have >= blob.byteSize) break;
    const length = Math.min(chunkBytes, blob.byteSize - have);
    let response: { status: number; json: unknown };
    try {
      // oxlint-disable-next-line no-await-in-loop -- ranged/resumable download: each chunk's offset comes from the file size the PREVIOUS chunk grew it to
      response = await dial.request({
        endpointTicket: dial.endpointTicketFor(
          route.endpointId,
          route.relayHints
        ),
        method: "GET",
        // `edgeId` is what lets the origin resolve exactly which link this
        // pull concerns (#726 audit finding 2) — two vaults co-hosted on one
        // remote gateway would otherwise share an endpoint and be
        // indistinguishable to it.
        target: `${PEER_BLOB_CHUNK_PATH}?sha256=${blob.sha256}&offset=${have}&length=${length}&edgeId=${encodeURIComponent(edgeId)}`,
      });
    } catch {
      return "pending";
    }
    const body =
      response.json !== null && typeof response.json === "object"
        ? (response.json as Record<string, unknown>)
        : {};
    if (
      response.status !== 200 ||
      body.state !== "chunk" ||
      typeof body.bytes !== "string"
    ) {
      return "pending";
    }
    const lease = parseLease(body.lease);
    if (
      !lease ||
      !acceptLease(lease, {
        edgeId: identity.edgeId,
        originVaultId: identity.originVaultId,
        audienceVaultId: identity.audienceVaultId,
        originPublicKey: identity.originPublicKey,
      })
    ) {
      return "pending";
    }
    store.renewLease(shapeId, lease.expiresAt);
    const bytes = Buffer.from(body.bytes, "base64");
    if (bytes.length === 0) return "pending"; // no progress — avoid spinning
    appendFileSync(tempPath, bytes);
  }
  const digest = await sha256OfFile(tempPath);
  if (digest !== blob.sha256) {
    // Corrupt or truncated — restart clean rather than resume onto garbage.
    rmSync(tempPath, { force: true });
    return "failed";
  }
  cas.adoptPulled(store, shapeId, blob, tempPath);
  return "done";
}

export interface FillBorrowedBlobsResult {
  done: string[];
  pending: string[];
  failed: string[];
  /** Withheld for the per-link byte budget, untouched — not a failure. */
  parked: string[];
}

/**
 * Split a pending list into what fits under budget and what doesn't, given
 * the store's CURRENT resident total. A blob that would tip the total over
 * budget parks — along with every candidate after it, so one big pull never
 * lets three small ones sneak in out of order and leave a confusing partial
 * state.
 */
function withinBudget(
  store: BorrowedStore,
  pending: readonly BorrowedBlobRef[],
  budgetBytes: number
): { fits: BorrowedBlobRef[]; parked: BorrowedBlobRef[] } {
  let running = store.residentByteTotal();
  const fits: BorrowedBlobRef[] = [];
  const parked: BorrowedBlobRef[] = [];
  for (const blob of pending) {
    if (parked.length > 0 || running + blob.byteSize > budgetBytes) {
      parked.push(blob);
      continue;
    }
    running += blob.byteSize;
    fits.push(blob);
  }
  return { fits, parked };
}

/** One tick's worth of REMOTE pulls for one shape, bounded by `limit`. */
export async function fillBorrowedBlobsOverPeer(input: {
  store: BorrowedStore;
  cas: BorrowedCas;
  shapeId: string;
  dial: PeerDial;
  route: PeerDialRoute;
  /** The already-linked edge identity used to verify each renewal. */
  identity: LendEdgeIdentity;
  /** The live edge this pull is for — carried on the wire so the origin can
   *  resolve exactly which link it concerns (#726 audit finding 2). */
  edgeId: string;
  limit: number;
  chunkBytes?: number;
  budgetBytes?: number;
}): Promise<FillBorrowedBlobsResult> {
  const pending = pendingPinnedBlobs(
    input.store,
    input.shapeId,
    input.cas
  ).slice(0, input.limit);
  const { fits, parked } = withinBudget(
    input.store,
    pending,
    input.budgetBytes ?? DEFAULT_BORROWED_LINK_BYTE_BUDGET
  );
  const result: FillBorrowedBlobsResult = {
    done: [],
    pending: [],
    failed: [],
    parked: parked.map((blob) => blob.sha256),
  };
  // Each blob is an independent pull (its own sha256, its own temp file), so
  // the fitted set runs concurrently rather than one blob at a time.
  const outcomes = await Promise.all(
    fits.map(async (blob) => ({
      blob,
      outcome: await pullOne(
        input.cas,
        input.store,
        input.shapeId,
        input.dial,
        input.route,
        input.identity,
        input.edgeId,
        blob,
        input.chunkBytes ?? DEFAULT_CHUNK_BYTES
      ),
    }))
  );
  for (const { blob, outcome } of outcomes) {
    result[outcome].push(blob.sha256);
  }
  return result;
}

/**
 * The co-hosted variant: both vaults sit on this gateway, so there is no wire
 * to chunk across — the bytes are a local file read away, in the origin
 * vault's own CAS. Same pending set, same pinned-only scope, same custody
 * bookkeeping via `BorrowedCas.put`, same budget gate.
 */
export function fillBorrowedBlobsLocally(input: {
  store: BorrowedStore;
  cas: BorrowedCas;
  shapeId: string;
  origin: LocalBlobStore;
  limit: number;
  budgetBytes?: number;
}): FillBorrowedBlobsResult {
  const pending = pendingPinnedBlobs(
    input.store,
    input.shapeId,
    input.cas
  ).slice(0, input.limit);
  const { fits, parked } = withinBudget(
    input.store,
    pending,
    input.budgetBytes ?? DEFAULT_BORROWED_LINK_BYTE_BUDGET
  );
  const result: FillBorrowedBlobsResult = {
    done: [],
    pending: [],
    failed: [],
    parked: parked.map((blob) => blob.sha256),
  };
  for (const blob of fits) {
    const bytes = input.origin.getSync(blob.sha256);
    if (!bytes) {
      // The origin's own bytes are absent (evicted remote tier, etc.) — a
      // state for the puller to retry later, never a thrown error.
      result.pending.push(blob.sha256);
      continue;
    }
    input.cas.put(input.store, input.shapeId, {
      sha256: blob.sha256,
      rung: blob.rung,
      bytes,
    });
    result.done.push(blob.sha256);
  }
  return result;
}
