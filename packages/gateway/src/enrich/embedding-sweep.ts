// The photo embedding spec (issue #724 W3, formerly `photo-embeddings.ts`):
// what the generic capability sweep needs to know in order to turn
// photographs into rows of `enrich_embedding`, so semantic search has
// something to search.
//
// WHAT MOVED AND WHAT DID NOT. The pass itself — consent gate, batching,
// per-item isolation, the resume story, the drain — is now
// `capability-sweep.ts` and shared with every other capability. What is left
// here is only what is TRUE OF PHOTOGRAPHS: which assets are behind, which
// bytes to send, and where the vector goes. The behaviour is the one issue
// #721 E2 shipped, with one addition: every written row now also leaves an
// `enrich_derivation` stamp, so a future model bump can find this capability's
// output the same way every other capability's is found.
//
// THE BACKFILL IS THE UPGRADE PATH, IN ONE JOIN. `e.embedding_id IS NULL` for
// the CURRENT model id means a bumped model version leaves every asset
// un-embedded *for the new model*, so the same sweep re-derives the library at
// its own pace while the old vectors keep answering searches until they are
// replaced. Nothing invalidates, nothing migrates.
//
// DERIVATIVES, NEVER ORIGINALS (issue #721 mandate). The bytes sent are the
// asset's `preview` (or, failing that, `thumb`) derivative. Preview first
// because a 2048 px raster carries the detail a vision model wants; thumb as
// the fallback because a tiny vector beats no vector. An asset with NEITHER
// rung is SKIPPED, not force-read from its original: the preview backstop will
// land one on a later sweep and this pass will find it then. The owner's
// full-resolution photograph is never sent anywhere.

import { encodeVector, uuidv7 } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { selectOpenRequests } from "./capability-sweep.js";
import type {
  CapabilitySweepBacklog,
  CapabilitySweepSpec,
  CapabilitySweepTarget,
} from "./capability-sweep.js";

/** The logical entity embeddings for photographs are keyed by. */
const TARGET_TYPE = "media.media_asset";

/**
 * The `enrich_request` tokens a photo-embedding ask carries. Deliberately the
 * queue's own vocabulary rather than the wire capability name: rows queued by
 * an earlier build say `embedding`, and a live queue is not renamed under a
 * deploy.
 */
const REQUEST_CAPABILITIES = ["embedding"] as const;

interface DerivativeRow {
  sha256: string;
  media_type: string;
}

/**
 * Photographs → `enrich_embedding`, on the shared sweep. Exported as a value
 * because there is exactly one of it: the spec is configuration, not a class.
 */
export const EMBEDDING_SWEEP_SPEC: CapabilitySweepSpec<"embed-image"> = {
  capability: "embed-image",
  policyDomain: "photos",
  targetType: TARGET_TYPE,
  variant: "embedding",

  selectBacklog: (db, input): CapabilitySweepBacklog => {
    // Owner asks first (issue #299 phase 5: "enrichers drain this queue
    // before the backlog").
    const requests = selectOpenRequests(db, {
      targetType: TARGET_TYPE,
      capabilityNames: REQUEST_CAPABILITIES,
      limit: input.limit,
      now: input.now,
    });

    const backfillLimit = Math.max(0, input.limit - requests.order.length);
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
        .all(TARGET_TYPE, input.model, backfillLimit) as unknown as {
        asset_id: string;
      }[]
    ).map((row) => row.asset_id);
    // Fewer rows than asked for ⇒ this pass saw the end of the library, which
    // is what makes a standing domain-wide request satisfiable.
    const exhausted = backfillLimit > 0 && backfill.length < backfillLimit;

    const targets: CapabilitySweepTarget[] = [
      ...requests.order.map((id) => ({
        id,
        requestIds: requests.byTarget.get(id) ?? [],
      })),
      ...backfill
        .filter((id) => !requests.byTarget.has(id))
        .map((id) => ({ id, requestIds: [] })),
    ];
    return { targets, domainRequestIds: requests.domain, exhausted };
  },

  buildItem: async (db, target) => {
    // Preview before thumb — see the header. `sha256 IS NOT NULL` excludes the
    // inline text derivatives (phash/thumbhash) that share this table.
    const row = db.vault
      .prepare(
        `SELECT d.sha256 AS sha256, d.media_type AS media_type
           FROM media_media_asset a
           JOIN core_content_derivative d ON d.content_id = a.content_id
          WHERE a.asset_id = ? AND a.deleted_at IS NULL
            AND d.variant IN ('preview','thumb') AND d.sha256 IS NOT NULL
          ORDER BY CASE d.variant WHEN 'preview' THEN 0 ELSE 1 END
          LIMIT 1`
      )
      .get(target.id) as DerivativeRow | undefined;
    if (!row) return null;
    // Local hit first; a remote-only derivative reads through custody at
    // indexing pace, exactly as the preview backstop does.
    const bytes =
      db.blobs.getSync(row.sha256) ?? (await db.blobs.open(row.sha256));
    if (!bytes) return null;
    return {
      id: target.id,
      mediaType: row.media_type,
      bytes: bytes.toString("base64"),
    };
  },

  apply: (db, input) => {
    writeEmbedding(db, {
      assetId: input.target.id,
      model: input.model,
      vector: input.result.vector,
      now: input.now,
    });
    // The stamp's payload: enough for an operator reading a stuck library to
    // see WHAT was written without a second copy of the vector.
    return { dim: input.result.vector.length };
  },
};

interface WriteEmbeddingInput {
  assetId: string;
  model: string;
  vector: readonly number[];
  now: string;
}

/**
 * Upsert the vector under `(target, model)`. The caller's transaction is
 * already open — see `capability-sweep.ts` on why the row, the stamp and the
 * drain are indivisible.
 */
function writeEmbedding(db: VaultDb, input: WriteEmbeddingInput): void {
  const blob = encodeVector(input.vector);
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
    return;
  }
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
