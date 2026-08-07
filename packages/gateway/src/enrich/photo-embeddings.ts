// The photo embedding indexer (issue #721 E2): the gateway-owned pass that
// turns photographs into rows of `enrich_embedding`, so E3's semantic search
// has something to search.
//
// THE QUEUE IS THE DATABASE. There is no in-memory work list, no cursor held
// across ticks, and no "resume from where we crashed" bookkeeping, because
// every one of those is state that can disagree with the vault. A pass asks
// two questions and both are answered by SQL over durable rows:
//
//   1. OPEN REQUESTS — `enrich_request` rows for `media.media_asset` whose
//      `required_capability` / `contribution_variant` is `embedding` and whose
//      `drained_at` is NULL. These are the member's own asks (a search that
//      found nothing, an explicit "index this now") and they go first.
//   2. THE BACKFILL SWEEP — live assets LEFT JOINed against
//      `enrich_embedding` for the CURRENT model id, taking the rows with no
//      match. This is also the E1 upgrade path in its entirety: bump the
//      embedder's model version and every asset is un-embedded again *for the
//      new model*, so the same sweep re-derives the library at its own pace
//      while the old vectors keep answering searches until they are replaced.
//
// A killed gateway therefore resumes by asking the same two questions. What it
// had half-done is simply still open.
//
// WHERE THE CPU LIVES. The embedding itself runs in a CHILD PROCESS (see
// `embedder.ts`) — an operator-chosen program the gateway spawns shell-free
// with a timeout and an output cap. That is already off this event loop, which
// is why this module is a plain bounded async pass rather than a worker thread
// on top of a subprocess: a second hop would add a serialization boundary and
// buy nothing. What this module owes the loop is PACE, and it pays that with a
// small batch (`PHOTO_EMBEDDING_BATCH`) and a yield between items, the same
// contract `blob/preview.ts`'s backstop keeps at 24/sweep.
//
// DERIVATIVES, NEVER ORIGINALS (issue #721 mandate). The bytes handed to the
// embedder are the asset's `preview` (or, failing that, `thumb`) derivative.
// Preview first because a 2048 px raster carries the detail a vision model
// wants; thumb as the fallback because a tiny vector beats no vector. An asset
// with NEITHER rung yet is SKIPPED, not force-read from its original: the
// preview backstop will land one on a later sweep and this pass will find it.
// The member's full-resolution photograph is never fed to a foreign process.
//
// CONSENT. The pass runs only while `enrich_policy` says the photos domain is
// at the `gateway` tier. `off` and `device` both mean "no gateway-lane model
// work on this vault" and the pass returns having read one row and written
// nothing — the same fail-closed reading `enrich/policy.ts` documents, where
// an unstated tier is a refusal rather than a default.

import {
  encodeVector,
  nowIso,
  readEnrichPolicyTier,
  uuidv7,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import type { Embedder } from "./embedder.js";

/**
 * Assets embedded per sweep. Calm by construction, like
 * `PREVIEW_BACKFILL_BATCH = 24`: a freshly imported library drains across
 * successive hourly sweeps rather than pinning a core the moment it mounts.
 * Lower than the preview batch because an embedder is a model, not a resize.
 */
export const PHOTO_EMBEDDING_BATCH = 16;

/** The logical entity embeddings for photographs are keyed by. */
const TARGET_TYPE = "media.media_asset";

export interface PhotoEmbeddingSweepResult {
  /**
   * `ok` — the pass ran (possibly finding nothing to do).
   * `no-embedder` — none is configured; the indexer is idle by design.
   * `policy` — the photos domain is not at the `gateway` tier.
   */
  status: "ok" | "no-embedder" | "policy";
  /** The model rows were written under, or null when the pass did not run. */
  model: string | null;
  /** Assets examined this pass (bounded by the batch cap). */
  scanned: number;
  /** Embedding rows actually written or replaced. */
  embedded: number;
  /** `enrich_request` rows stamped `drained_at` by this pass. */
  drained: number;
  /** Assets with no thumb/preview derivative yet — retried after one lands. */
  skippedNoDerivative: number;
  /** Assets whose embedder call failed. Counted, never fatal to the batch. */
  failed: number;
}

export interface PhotoEmbeddingSweepOptions {
  embedder: Embedder | null;
  /** Assets to touch this pass. Defaults to `PHOTO_EMBEDDING_BATCH`. */
  limit?: number;
  now?: string;
  /** Reason a per-asset embed failed — surfaced to the plane's operator log. */
  onFailure?: (assetId: string, reason: string) => void;
}

interface OpenRequest {
  request_id: string;
  target_id: string | null;
}

function emptyResult(
  status: PhotoEmbeddingSweepResult["status"],
  model: string | null
): PhotoEmbeddingSweepResult {
  return {
    status,
    model,
    scanned: 0,
    embedded: 0,
    drained: 0,
    skippedNoDerivative: 0,
    failed: 0,
  };
}

/** Yield the event loop between assets — indexing never starves live work. */
function yieldTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * One bounded indexing pass. Safe to call on any cadence and from a cold
 * start: it holds nothing between calls.
 */
export async function runPhotoEmbeddingSweep(
  db: VaultDb,
  options: PhotoEmbeddingSweepOptions
): Promise<PhotoEmbeddingSweepResult> {
  const { embedder } = options;
  if (!embedder) return emptyResult("no-embedder", null);
  // The consent gate, read fresh every pass so an owner turning enrichment off
  // stops the NEXT sweep without a remount.
  if (readEnrichPolicyTier(db.vault, "photos") !== "gateway")
    return emptyResult("policy", embedder.model);

  const limit = options.limit ?? PHOTO_EMBEDDING_BATCH;
  const now = options.now ?? nowIso();
  const result = emptyResult("ok", embedder.model);
  if (limit <= 0) return result;

  // Member asks first (issue #299 phase 5: "enrichers drain this queue before
  // the backlog"). A row under a LIVE device lease is left alone — that device
  // claimed the work and the gateway is not its competitor.
  const requests = db.vault
    .prepare(
      `SELECT request_id, target_id FROM enrich_request
        WHERE drained_at IS NULL
          AND target_type = ?
          AND (required_capability = 'embedding' OR contribution_variant = 'embedding')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY requested_at
        LIMIT ?`
    )
    .all(TARGET_TYPE, now, limit) as unknown as OpenRequest[];

  // Requests naming an asset become work; a request naming the whole domain
  // (target_id NULL — "index my photos") is a standing ask that the backfill
  // below already serves, so it drains once the backfill has nothing left.
  const requestedAssets: string[] = [];
  const requestsByAsset = new Map<string, string[]>();
  const domainRequests: string[] = [];
  for (const row of requests) {
    if (row.target_id === null) {
      domainRequests.push(row.request_id);
      continue;
    }
    const existing = requestsByAsset.get(row.target_id);
    if (existing) existing.push(row.request_id);
    else {
      requestsByAsset.set(row.target_id, [row.request_id]);
      requestedAssets.push(row.target_id);
    }
  }

  // The backfill half. `e.embedding_id IS NULL` is the whole upgrade story:
  // for a bumped model version no asset has a row yet, so the library
  // re-derives without any explicit "invalidate" step.
  const backfillLimit = Math.max(0, limit - requestedAssets.length);
  const backfill = (
    db.vault
      .prepare(
        `SELECT a.asset_id AS asset_id FROM media_media_asset a
           LEFT JOIN enrich_embedding e
             ON e.target_type = ? AND e.target_id = a.asset_id AND e.model = ?
          WHERE a.deleted_at IS NULL AND e.embedding_id IS NULL
          ORDER BY a.asset_id
          LIMIT ?`
      )
      .all(TARGET_TYPE, embedder.model, backfillLimit) as unknown as {
      asset_id: string;
    }[]
  ).map((row) => row.asset_id);
  // Fewer rows than asked for ⇒ the backfill saw the end of the library this
  // pass, which is what makes a standing domain-wide request satisfiable.
  const backfillDrained = backfillLimit > 0 && backfill.length < backfillLimit;

  const assets = [
    ...requestedAssets,
    ...backfill.filter((id) => !requestsByAsset.has(id)),
  ];

  const derivativeOf = db.vault.prepare(
    // Preview before thumb — see the header. `sha256 IS NOT NULL` excludes the
    // inline text derivatives (phash/thumbhash) that share this table.
    `SELECT a.content_id AS content_id, d.sha256 AS sha256
       FROM media_media_asset a
       JOIN core_content_derivative d ON d.content_id = a.content_id
      WHERE a.asset_id = ? AND a.deleted_at IS NULL
        AND d.variant IN ('preview','thumb') AND d.sha256 IS NOT NULL
      ORDER BY CASE d.variant WHEN 'preview' THEN 0 ELSE 1 END
      LIMIT 1`
  );

  // Strictly sequential, and recursive rather than a loop for the same reason
  // `blob/preview.ts`'s backstop is: the assets MUST be processed one at a
  // time — each one spawns a model process, and running the batch in parallel
  // would hand a Pi-class host sixteen of them at once — so `Promise.all` is
  // the wrong shape here, not merely a stylistic alternative.
  // Re-bound because the recursive helper below is a hoisted declaration, and
  // TypeScript will not carry the null guard at the top of this function into
  // one. Not a re-check — the same value, named so the closure can see it.
  const active: Embedder = embedder;
  async function embedNext(index: number): Promise<void> {
    const assetId = assets[index];
    if (assetId === undefined) return;
    result.scanned += 1;
    const row = derivativeOf.get(assetId) as
      | { content_id: string; sha256: string }
      | undefined;
    // Local hit first; a remote-only derivative reads through custody at
    // indexing pace, exactly as the preview backstop does.
    const bytes = row
      ? (db.blobs.getSync(row.sha256) ?? (await db.blobs.open(row.sha256)))
      : null;
    if (!bytes) {
      result.skippedNoDerivative += 1;
      return embedNext(index + 1);
    }
    let vector: number[];
    try {
      vector = await active.embedImage(bytes);
    } catch (error) {
      // A process boundary with a recovery: one photograph the operator's
      // program could not read must not sink the batch or the sweep this pass
      // rides along with. The failure is counted and reported, never silent.
      result.failed += 1;
      options.onFailure?.(
        assetId,
        error instanceof Error ? error.message : String(error)
      );
      return embedNext(index + 1);
    }
    writeEmbedding(db, {
      assetId,
      model: active.model,
      vector,
      now,
      requestIds: requestsByAsset.get(assetId) ?? [],
      result,
    });
    await yieldTick();
    return embedNext(index + 1);
  }
  await embedNext(0);

  if (backfillDrained && domainRequests.length > 0)
    result.drained += drainRequests(db, domainRequests, now);

  return result;
}

interface WriteEmbeddingInput {
  assetId: string;
  model: string;
  vector: number[];
  now: string;
  requestIds: readonly string[];
  result: PhotoEmbeddingSweepResult;
}

/**
 * The row and the drain land TOGETHER or not at all. A crash between them
 * would either lose an embedding a request believes was served, or drain an
 * ask nothing answered — and the second is the one no later sweep repairs,
 * because a drained request is invisible to the claim query above.
 */
function writeEmbedding(db: VaultDb, input: WriteEmbeddingInput): void {
  const blob = encodeVector(input.vector);
  db.vault.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.vault
      .prepare(
        `SELECT embedding_id FROM enrich_embedding
          WHERE target_type = ? AND target_id = ? AND model = ?`
      )
      .get(TARGET_TYPE, input.assetId, input.model) as
      | { embedding_id: string }
      | undefined;
    if (existing) {
      db.vault
        .prepare(
          `UPDATE enrich_embedding SET dim = ?, vector = ?, created_at = ?
            WHERE embedding_id = ?`
        )
        .run(input.vector.length, blob, input.now, existing.embedding_id);
    } else {
      db.vault
        .prepare(
          `INSERT INTO enrich_embedding
             (embedding_id, target_type, target_id, model, dim, vector, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          uuidv7(),
          TARGET_TYPE,
          input.assetId,
          input.model,
          input.vector.length,
          blob,
          input.now
        );
    }
    input.result.embedded += 1;
    input.result.drained += markDrained(db, input.requestIds, input.now);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

/** Stamp `drained_at` on requests this pass answered, in their own transaction. */
function drainRequests(
  db: VaultDb,
  requestIds: readonly string[],
  now: string
): number {
  db.vault.exec("BEGIN IMMEDIATE");
  try {
    const drained = markDrained(db, requestIds, now);
    db.vault.exec("COMMIT");
    return drained;
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

/** Caller owns the transaction. Mirrors `enrich.mark_requests_drained`. */
function markDrained(
  db: VaultDb,
  requestIds: readonly string[],
  now: string
): number {
  if (requestIds.length === 0) return 0;
  const mark = db.vault.prepare(
    `UPDATE enrich_request SET drained_at = ?
      WHERE request_id = ? AND drained_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
  );
  let drained = 0;
  for (const requestId of requestIds)
    drained += Number(mark.run(now, requestId, now).changes);
  return drained;
}
