/*
 * The AUDIENCE-side half of a remote give's byte custody (#726 P3 decision
 * 7): derivatives already crossed with the closure, so what remains is the
 * ORIGINAL, pulled by sha — RANGED, resumable across interruption, sha256
 * verified before the bytes become durable.
 *
 * Since #750 the queue is not a table of its own: `pull-blob` effects live in
 * the ONE share outbox, and `runBlobPull` is what `share-effect-executor.ts`
 * calls for each. Nothing records those effects any more — the give frames
 * that did retired with copy-as-share (#825, ruling G-copy) — so this half
 * runs only against rows an older build left behind.
 *
 * Resumability needs no extra state beyond what is on disk: `tmpPath` is
 * minted ONCE (the vault's own `promotionTempPathSync` — same filesystem as
 * its CAS, so the eventual adopt is a rename) and its byte length on disk IS
 * the offset to resume from. A network failure mid-pull leaves the partial
 * file and the effect exactly where they were — nothing to roll back.
 */

import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, rmSync, statSync } from "node:fs";

import type { ShareVaultRef } from "@centraid/vault";

import { PEER_BLOB_CHUNK_PATH } from "./peer-blob-route-path.js";
import type { PeerDial, PeerDialRoute } from "./peer-edge-give-client.js";

const DEFAULT_BLOB_CHUNK_BYTES = 4 * 1024 * 1024;

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

export type PullBlobOutcome =
  | { state: "done" }
  /** Interrupted. `progressed` says whether bytes actually moved this pass. */
  | { state: "pending"; progressed: boolean }
  | { state: "failed"; reason: string };

export interface RunBlobPullInput {
  audience: ShareVaultRef;
  dial: PeerDial;
  route: PeerDialRoute;
  edgeId: string;
  sha256: string;
  size: number;
  tmpPath: string;
  chunkBytes?: number;
}

/**
 * Pull ONE original to durable, resuming from whatever `tmpPath` already
 * holds. Never throws for a network condition — a peer that is offline or
 * partitioned mid-transfer leaves this "pending", never an exception the
 * caller would have to turn into a 500.
 */
export async function runBlobPull(
  input: RunBlobPullInput
): Promise<PullBlobOutcome> {
  const store = input.audience.blobs.local;
  if (store.hasSync(input.sha256)) return { state: "done" };
  const chunkBytes = input.chunkBytes ?? DEFAULT_BLOB_CHUNK_BYTES;
  const startedAt = fileSizeOf(input.tmpPath);
  const progressed = (): boolean => fileSizeOf(input.tmpPath) > startedAt;
  for (;;) {
    const have = fileSizeOf(input.tmpPath);
    if (have >= input.size) break;
    const length = Math.min(chunkBytes, input.size - have);
    let response: { status: number; json: unknown };
    try {
      // oxlint-disable-next-line no-await-in-loop -- ranged/resumable download: each chunk's offset comes from the file size the PREVIOUS chunk grew it to
      response = await input.dial.request({
        endpointTicket: input.dial.endpointTicketFor(
          input.route.endpointId,
          input.route.relayHints
        ),
        method: "GET",
        // `edgeId` is what lets the origin resolve exactly which link this
        // pull concerns (#726 audit finding 2) — two vaults co-hosted on one
        // remote gateway would otherwise share an endpoint and be
        // indistinguishable to it.
        target: `${PEER_BLOB_CHUNK_PATH}?sha256=${input.sha256}&offset=${have}&length=${length}&edgeId=${encodeURIComponent(input.edgeId)}`,
      });
    } catch {
      return { state: "pending", progressed: progressed() };
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
      return { state: "pending", progressed: progressed() };
    }
    const bytes = Buffer.from(body.bytes, "base64");
    // No progress — return rather than spin.
    if (bytes.length === 0)
      return { state: "pending", progressed: progressed() };
    appendFileSync(input.tmpPath, bytes);
  }
  const digest = await sha256OfFile(input.tmpPath);
  if (digest !== input.sha256) {
    // Corrupt or truncated — restart clean rather than resume onto garbage.
    rmSync(input.tmpPath, { force: true });
    return { state: "failed", reason: "pulled bytes failed their sha256" };
  }
  // Sha-verified CAS adoption IS this effect's idempotency anchor: a replay
  // after a crash finds the bytes resident and discharges immediately.
  store.adoptTempSync?.(input.sha256, input.tmpPath);
  return { state: "done" };
}
