/*
 * The AUDIENCE-side half of a remote give's byte custody (#726 P3 decision
 * 7): derivatives already crossed with the closure, so what remains is the
 * ORIGINAL, pulled by sha — RANGED, resumable across interruption, sha256
 * verified before the row becomes durable. Runs entirely off the request
 * path: `recordPendingPulls` is called once, synchronously, inside the give
 * handler; `drainPeerBlobPulls` is the background worker's tick, called as
 * many times as it takes.
 *
 * Resumability needs no extra state beyond what's on disk: `tmp_path` is
 * minted ONCE (the vault's own `promotionTempPathSync` — same filesystem as
 * its CAS, so the eventual adopt is a rename) and its byte length on disk IS
 * the offset to resume from. A network failure mid-pull leaves the partial
 * file and the row exactly where they were — nothing to roll back.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, rmSync, statSync } from "node:fs";

import type { BlobManifestEntry, ShareVaultRef } from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";
import { PEER_BLOB_CHUNK_PATH } from "./peer-blob-route-path.js";
import type { PeerDial, PeerDialRoute } from "./peer-edge-give-client.js";
import { ShareEffectsStore } from "./share-effects.js";
import { peerViewOf } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

interface PendingPullRow {
  effect_id: string;
  edge_id: string;
  link_id: string;
  local_vault_id: string;
  sha256: string;
  size: number;
  tmp_path: string;
  attempts: number;
}

/** Queue every ORIGINAL-rung blob a just-projected give still needs, sha-deduped. */
export function recordPendingPulls(
  db: GatewayDatabase,
  audience: ShareVaultRef,
  input: {
    edgeId: string;
    linkId: string;
    localVaultId: string;
    peerVaultId: string;
    originals: readonly BlobManifestEntry[];
  }
): void {
  const effects = new ShareEffectsStore(db);
  for (const entry of input.originals) {
    // Re-give short-circuits by sha: already-resident bytes need no pull row.
    if (audience.blobs.local.hasSync(entry.sha256)) continue;
    const existing = effects
      .list({ kind: "pull-blob", active: true })
      .some(
        (effect) =>
          effect.localVaultId === input.localVaultId &&
          effect.kind === "pull-blob" &&
          effect.payload.sha256 === entry.sha256
      );
    if (existing) continue;
    const tmpPath = audience.blobs.local.promotionTempPathSync?.(entry.sha256);
    // No streaming-adoption seam (the in-memory tier) — nothing durable to
    // resume across, so there is no pull to track. Vault-package scope keeps
    // this module from doing anything about that here.
    if (!tmpPath) continue;
    effects.enqueue({
      effectId: randomUUID(),
      edgeId: input.edgeId,
      kind: "pull-blob",
      localVaultId: input.localVaultId,
      peerVaultId: input.peerVaultId,
      payload: {
        linkId: input.linkId,
        sha256: entry.sha256,
        size: entry.size,
        tmpPath,
      },
    });
  }
}

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

export type PullBlobOutcome = "done" | "pending" | "failed";

/**
 * Pull ONE original to durable, resuming from whatever `tmp_path` already
 * holds. Never throws for a network condition — a peer that is offline or
 * partitioned mid-transfer leaves this "pending", never an exception the
 * caller would have to turn into a 500.
 */
async function pullOne(
  effects: ShareEffectsStore,
  audience: ShareVaultRef,
  dial: PeerDial,
  route: PeerDialRoute,
  row: PendingPullRow,
  chunkBytes: number
): Promise<PullBlobOutcome> {
  const store = audience.blobs.local;
  const done = (): void => {
    effects.transition(row.effect_id, "executed");
  };
  if (store.hasSync(row.sha256)) {
    done();
    return "done";
  }
  for (;;) {
    const have = fileSizeOf(row.tmp_path);
    if (have >= row.size) break;
    const length = Math.min(chunkBytes, row.size - have);
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
        target: `${PEER_BLOB_CHUNK_PATH}?sha256=${row.sha256}&offset=${have}&length=${length}&edgeId=${encodeURIComponent(row.edge_id)}`,
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
    const bytes = Buffer.from(body.bytes, "base64");
    if (bytes.length === 0) return "pending"; // no progress — avoid spinning
    appendFileSync(row.tmp_path, bytes);
  }
  const digest = await sha256OfFile(row.tmp_path);
  if (digest !== row.sha256) {
    // Corrupt or truncated — restart clean rather than resume onto garbage.
    rmSync(row.tmp_path, { force: true });
    effects.transition(row.effect_id, "failed", { attempted: true });
    return "failed";
  }
  store.adoptTempSync?.(row.sha256, row.tmp_path);
  done();
  return "done";
}

export interface DrainPeerBlobPullsResult {
  done: string[];
  pending: string[];
  failed: string[];
}

function selectPendingPulls(
  db: GatewayDatabase,
  edgeId: string | undefined,
  limit: number | undefined
): PendingPullRow[] {
  return new ShareEffectsStore(db)
    .list({
      kind: "pull-blob",
      active: true,
      ...(edgeId ? { edgeId } : {}),
      ...(limit === undefined ? {} : { limit }),
    })
    .flatMap((effect) =>
      effect.kind === "pull-blob"
        ? [
            {
              effect_id: effect.effectId,
              edge_id: effect.edgeId,
              link_id: effect.payload.linkId,
              local_vault_id: effect.localVaultId,
              sha256: effect.payload.sha256,
              size: effect.payload.size,
              tmp_path: effect.payload.tmpPath,
              attempts: effect.attempts,
            },
          ]
        : []
    );
}

/** One background-worker tick: advance every (or one edge's) pending pull. */
export async function drainPeerBlobPulls(input: {
  db: GatewayDatabase;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  dial: PeerDial;
  edgeId?: string;
  chunkBytes?: number;
  /** Rows processed this call; unbounded when omitted (a scheduler tick bounds it). */
  limit?: number;
}): Promise<DrainPeerBlobPullsResult> {
  const rows = selectPendingPulls(input.db, input.edgeId, input.limit);
  const effects = new ShareEffectsStore(input.db);
  const result: DrainPeerBlobPullsResult = {
    done: [],
    pending: [],
    failed: [],
  };
  // Every row is an independent pull (its own sha256, its own temp file), so
  // this tick's rows run concurrently rather than one at a time.
  await Promise.all(
    rows.map(async (row) => {
      const audience = input.vaultFor(row.local_vault_id);
      const link = input.links.get(row.link_id);
      const view = link ? peerViewOf(link, row.local_vault_id) : undefined;
      if (!audience || !view) {
        effects.transition(row.effect_id, "parked", {
          attempted: true,
          retryAt: retryAt(row.attempts),
        });
        result.pending.push(row.sha256);
        return;
      }
      const outcome = await pullOne(
        effects,
        audience,
        input.dial,
        view.route,
        row,
        input.chunkBytes ?? DEFAULT_CHUNK_BYTES
      );
      if (outcome === "pending") {
        effects.transition(row.effect_id, "parked", {
          attempted: true,
          retryAt: retryAt(row.attempts),
        });
      }
      result[outcome].push(row.sha256);
    })
  );
  return result;
}

function retryAt(attempts: number): number {
  return Date.now() + Math.min(60_000 * 2 ** attempts, 15 * 60_000);
}
