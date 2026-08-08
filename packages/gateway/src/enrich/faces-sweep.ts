// The face-detection spec (issue #724 W5): what the generic capability sweep
// needs in order to turn photographs into `media_face_region` proposals and the
// face vectors that group them.
//
// CONSENT-GATED, NOT AMBIENT — the one way this spec differs from every other.
// `embedding-sweep.ts` fills its batch from a LEFT JOIN over the whole library:
// every asset with no vector for the current model is behind, always, and the
// only gate is the domain tier. That is right for embeddings and WRONG for
// faces. Issue #712 fixed exactly this shape one layer down, on the queue row:
// before it, an owner's "detect faces now" was an UNTAGGED `enrich_request`, so
// a face-detection consent was handed to every enabled enricher. Tagging the
// row fixed who may drain it; it does not help at all if the drainer then
// ignores the queue and sweeps the library anyway. So there is deliberately no
// unconditional backfill query in this file. A photograph enters this pass in
// exactly three ways, and each is a consent record on disk:
//
//   1. An OPEN `enrich_request` naming this asset, tagged `capability='faces'`.
//   2. An OPEN vault-wide `enrich_request` (`target_id IS NULL`, same tag) —
//      the "detect faces across my library" ask. THAT ROW is what licenses the
//      library scan, the scan stops when the row is drained, and a member who
//      never asked has no such row, so this pass reads no photograph of theirs
//      and makes no request to the service.
//   3. A target this capability has ALREADY derived under an older model
//      (`supersededTargets` over the `enrich_derivation` stamps). A stamp is
//      proof of past consent for that photograph; re-deriving it under a newer
//      model is finishing the same job, not starting a new one. This is the
//      only path that runs with no open request, and it can never reach a
//      photograph that was not already processed with permission.
//
// DERIVATIVES, NEVER ORIGINALS (issue #721 mandate, unchanged). The bytes sent
// are the asset's `preview` (or `thumb`) derivative. The member's
// full-resolution photograph is never sent anywhere.
//
// BOXES COME BACK IN ORIGINAL PIXELS; THE LEDGER STORES FRACTIONS. The item
// declares `originalWidth`/`originalHeight`, so the service returns boxes in
// the ORIGINAL photograph's pixel space regardless of how far it downscaled
// (service-client.ts validates that). `media_face_region.bbox_json` is a
// fraction of the full photograph — `{x, y, w, h}`, each 0..1 — because that is
// what every surface drawing a crop needs and the only form that survives a new
// derivative rung. An asset whose `width`/`height` are unknown is therefore
// SKIPPED rather than stored in pixels: a pixel box in a fraction-shaped column
// renders a face marker over empty canvas, which tells a member the model saw
// something it did not.
//
// AN ANSWERED REGION IS NEVER TOUCHED. Re-deriving an asset (a newer model, a
// repeated ask) replaces its PROPOSED regions and nothing else. `confirmed`,
// `rejected` and `dismissed` rows are the member's own answers; a sweep that
// could undo them would make the review queue unfinishable, which is the defect
// issue #712 removed from the schema and this file must not reintroduce from
// above. Region ids are derived from `(asset, model, box)`, so the same model
// re-run over the same photograph produces the SAME rows — the replace is a
// no-op, nothing churns, and no replica is woken.

import { createHash } from "node:crypto";

import { encodeVector, supersededTargets, uuidv7 } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { selectOpenRequests } from "./capability-sweep.js";
import type {
  CapabilitySweepBacklog,
  CapabilitySweepSpec,
  CapabilitySweepTarget,
} from "./capability-sweep.js";
import type { EnrichBox } from "./service-client.js";

/** The logical entity face proposals are derived FROM. */
const TARGET_TYPE = "media.media_asset";
/** The logical entity a face VECTOR is keyed by (`schema/tables.ts`). */
const FACE_TARGET_TYPE = "media.face_region";
/** `enrich_derivation.variant` for this capability's output. */
const VARIANT = "faces";

/**
 * The `enrich_request.capability` consent tag this pass drains. It is the tag
 * `packages/blueprints/apps/photos/actions/request-enrichment.ts` pins on the
 * owner's "detect faces" ask, and it is the whole reason that ask does not read
 * as consent for captioning and screenshot OCR too.
 */
const CONSENT_CAPABILITIES = ["faces"] as const;

/**
 * The device-lease vocabulary. `faces` is not in `enrich_request`'s
 * `required_capability` CHECK — that enum is the on-device lease lane and
 * predates this capability — so this list is empty and the consent tag above is
 * the only match. Passed explicitly rather than omitted so the two vocabularies
 * stay visible side by side.
 */
const REQUEST_CAPABILITIES: readonly string[] = [];

interface AssetRow {
  sha256: string;
  media_type: string;
  width: number | null;
  height: number | null;
}

/**
 * A face region's id, derived from what produced it: the asset, the model, and
 * the box. Deterministic on purpose — see the header. Prefixed and readable in
 * the same spirit as `memories.ts`'s `otd:`/`trip:` ids, so an operator reading
 * a row can tell a derived proposal from an authored row at a glance.
 */
function regionIdFor(assetId: string, model: string, box: EnrichBox): string {
  const digest = createHash("sha256")
    .update(`${assetId}\n${model}\n${box.join(",")}`)
    .digest("hex");
  return `face-${digest.slice(0, 32)}`;
}

/** Photographs → `media_face_region` + face vectors, on the shared sweep. */
export const FACES_SWEEP_SPEC: CapabilitySweepSpec<"faces"> = {
  capability: "faces",
  policyDomain: "photos",
  targetType: TARGET_TYPE,
  variant: VARIANT,

  selectBacklog: (db, input): CapabilitySweepBacklog => {
    const requests = selectOpenRequests(db, {
      targetType: TARGET_TYPE,
      capabilityNames: REQUEST_CAPABILITIES,
      consentCapabilities: CONSENT_CAPABILITIES,
      limit: input.limit,
      now: input.now,
    });

    const seen = new Set(requests.order);
    const targets: CapabilitySweepTarget[] = requests.order.map((id) => ({
      id,
      requestIds: requests.byTarget.get(id) ?? [],
    }));

    // Model supersession, INSIDE the already-consented set. A stamp exists
    // only where this capability already ran with permission, so re-deriving
    // one reaches no photograph a member did not already hand over.
    const supersededBudget = Math.max(0, input.limit - targets.length);
    if (supersededBudget > 0) {
      for (const stale of supersededTargets(db.vault, {
        capability: "faces",
        variant: VARIANT,
        currentModel: input.model,
        targetType: TARGET_TYPE,
        limit: supersededBudget,
      })) {
        if (seen.has(stale.targetId)) continue;
        seen.add(stale.targetId);
        targets.push({ id: stale.targetId, requestIds: [] });
      }
    }

    // The vault-wide ask. Only an OPEN domain request licenses this scan, and
    // when it is drained the scan stops with it — which is what makes this a
    // consent-scoped backfill rather than the ambient one the header refuses.
    const domainBudget =
      requests.domain.length > 0
        ? Math.max(0, input.limit - targets.length)
        : 0;
    let exhausted = false;
    if (domainBudget > 0) {
      const rows = db.vault
        .prepare(
          `SELECT a.asset_id AS asset_id FROM media_media_asset a
             LEFT JOIN enrich_derivation d
               ON d.target_type = ? AND d.target_id = a.asset_id AND d.variant = ?
            WHERE a.deleted_at IS NULL AND d.derivation_id IS NULL
            ORDER BY a.asset_id
            LIMIT ?`
        )
        .all(TARGET_TYPE, VARIANT, domainBudget) as unknown as {
        asset_id: string;
      }[];
      for (const row of rows) {
        if (seen.has(row.asset_id)) continue;
        seen.add(row.asset_id);
        targets.push({ id: row.asset_id, requestIds: [] });
      }
      // Fewer rows than asked for ⇒ this pass saw the end of the library, which
      // is what makes the standing ask satisfiable.
      exhausted = rows.length < domainBudget;
    }

    return { targets, domainRequestIds: requests.domain, exhausted };
  },

  buildItem: async (db, target) => {
    const row = db.vault
      .prepare(
        `SELECT d.sha256 AS sha256, d.media_type AS media_type,
                a.width AS width, a.height AS height
           FROM media_media_asset a
           JOIN core_content_derivative d ON d.content_id = a.content_id
          WHERE a.asset_id = ? AND a.deleted_at IS NULL
            AND d.variant IN ('preview','thumb') AND d.sha256 IS NOT NULL
          ORDER BY CASE d.variant WHEN 'preview' THEN 0 ELSE 1 END
          LIMIT 1`
      )
      .get(target.id) as AssetRow | undefined;
    if (!row) return null;
    // Honest absence, not a guess: without the original's dimensions a returned
    // box cannot be expressed as the fraction the ledger stores. See the header.
    if (!row.width || !row.height) return null;
    const bytes =
      db.blobs.getSync(row.sha256) ?? (await db.blobs.open(row.sha256));
    if (!bytes) return null;
    return {
      id: target.id,
      mediaType: row.media_type,
      bytes: bytes.toString("base64"),
      originalWidth: row.width,
      originalHeight: row.height,
    };
  },

  apply: (db, input) => {
    const assetId = input.target.id;
    const size = db.vault
      .prepare("SELECT width, height FROM media_media_asset WHERE asset_id = ?")
      .get(assetId) as { width: number | null; height: number | null };
    // `buildItem` refused the asset without these, so the batch this result
    // belongs to cannot contain one that lost them since — but reading them
    // again is what makes the fraction below true of THIS row rather than of
    // whatever the item happened to declare.
    const width = size.width ?? 0;
    const height = size.height ?? 0;

    const desired = new Map<
      string,
      { box: EnrichBox; confidence: number; embedding: readonly number[] }
    >();
    for (const face of input.result.faces) {
      desired.set(regionIdFor(assetId, input.model, face.box), {
        box: face.box,
        confidence: face.confidence,
        embedding: face.embedding,
      });
    }

    // Replace the PROPOSED regions of an earlier model, and only those. The
    // `review_state = 'proposed'` filter is the invariant this file exists to
    // hold: an answered region belongs to the member.
    const stale = (
      db.vault
        .prepare(
          `SELECT region_id FROM media_face_region
            WHERE asset_id = ? AND review_state = 'proposed'
            ORDER BY region_id`
        )
        .all(assetId) as unknown as { region_id: string }[]
    ).filter((row) => !desired.has(row.region_id));
    for (const row of stale) {
      db.vault
        .prepare(
          "DELETE FROM enrich_embedding WHERE target_type = ? AND target_id = ?"
        )
        .run(FACE_TARGET_TYPE, row.region_id);
      db.vault
        .prepare("DELETE FROM media_face_cluster WHERE region_id = ?")
        .run(row.region_id);
      db.vault
        .prepare(
          "DELETE FROM media_face_region WHERE region_id = ? AND review_state = 'proposed'"
        )
        .run(row.region_id);
    }

    const insertRegion = db.vault.prepare(
      `INSERT INTO media_face_region
         (region_id, asset_id, bbox_json, party_id, confidence,
          confirmed_by_party_id, review_state)
       VALUES (?, ?, ?, NULL, ?, NULL, 'proposed')
       ON CONFLICT (region_id) DO NOTHING`
    );
    for (const [regionId, face] of [...desired].sort(([a], [b]) =>
      a < b ? -1 : 1
    )) {
      const [x, y, w, h] = face.box;
      insertRegion.run(
        regionId,
        assetId,
        JSON.stringify({
          x: x / width,
          y: y / height,
          w: w / width,
          h: h / height,
        }),
        face.confidence
      );
      writeFaceEmbedding(db, {
        regionId,
        model: input.model,
        vector: face.embedding,
        now: input.now,
      });
    }
    // The stamp's payload: what an operator reading a stuck library needs to
    // see WHAT was produced, without a second copy of any vector or box.
    return { faces: desired.size };
  },
};

interface WriteFaceEmbeddingInput {
  regionId: string;
  model: string;
  vector: readonly number[];
  now: string;
}

/**
 * Upsert one face vector under `(region, model)`. The caller's transaction is
 * already open — see `capability-sweep.ts` on why the row, the stamp and the
 * drain are indivisible.
 */
function writeFaceEmbedding(db: VaultDb, input: WriteFaceEmbeddingInput): void {
  const blob = encodeVector(input.vector);
  const existing = db.vault
    .prepare(
      `SELECT embedding_id FROM enrich_embedding
        WHERE target_type = ? AND target_id = ? AND model = ?`
    )
    .get(FACE_TARGET_TYPE, input.regionId, input.model) as
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
      FACE_TARGET_TYPE,
      input.regionId,
      input.model,
      input.vector.length,
      blob,
      input.now
    );
}
