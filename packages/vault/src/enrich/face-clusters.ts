// Face grouping (issue #724 W5): the pass that turns a pile of detected face
// regions into two useful things — "this looks like Ana, is it?" and "here are
// eleven photographs of somebody you have not named".
//
// PARTY-ANCHORED, WHICH IS THE WHOLE DESIGN. Identity in this vault is a
// `core_party` row, asserted by the owner through `media.answer_face_proposal`
// and recorded on `media_face_region.party_id` / `.confirmed_by_party_id`.
// This module never creates an identity and never confirms one. It does two
// strictly weaker things:
//
//   1. CENTROID MATCH. For every party the owner has already confirmed a face
//      for, average that party's confirmed face vectors. An unassigned
//      PROPOSED region close to exactly one such centroid gets that party
//      written onto it — still `review_state = 'proposed'`, so it lands in the
//      review queue the app already has, as the question "is this Ana?" rather
//      than as an answer. The owner's `confirmed` rows are never touched, and
//      the shape of the row is exactly what `media_face_region`'s CHECKs
//      already call an enricher's candidate.
//   2. STRANGER GROUPING. Whatever is left — proposed, unnamed, unmatched —
//      is grouped against itself and the groups are written to
//      `media_face_cluster`, a rebuildable projection (schema/enrich.ts). A
//      group is a naming affordance, not a person: it exists so a People shelf
//      can offer "name this one" over eleven faces instead of eleven times.
//
// WHAT IS NEVER RE-PROPOSED. A `rejected` or `dismissed` region has been
// answered. The DDL already refuses it a party (`review_state IN
// ('proposed','confirmed') OR party_id IS NULL`), and this pass honours the
// same fact one level up: answered regions are read for NOTHING — not as
// centroid material, not as clustering candidates, not as assignment targets.
// A queue whose answers can be undone by the next sweep is a queue that can
// never be finished, which is the exact defect issue #712 fixed in the schema.
//
// EVERY COMPARISON HAPPENS WITHIN ONE MODEL. Cosine distance between vectors
// from two different embedders is a number with no meaning. So the pass
// partitions regions by `enrich_embedding.model` and runs independently per
// model. The visible consequence of a model upgrade is therefore that faces
// re-propose rather than silently inheriting centroids computed in a vector
// space that no longer exists — slower, and the only honest option.
//
// THE THRESHOLDS ARE STRICTER THAN THE LITERATURE, ON PURPOSE. Published face
// embedders are usually tuned at a cosine distance around 0.4, which balances
// false merges against false splits as if the two cost the same. They do not.
// A false merge tells a member their library contains a photograph of their
// sister that is actually a stranger, and it is discovered — if it ever is —
// long after they trusted the grouping; a false split costs one gesture to
// merge two shelves. So both constants below sit well inside the published
// operating point, and the stranger-grouping one is stricter still, because a
// stranger group is named in ONE act: a bad merge there mislabels every face
// in it at once.
//
// NO CHAINING. Stranger grouping is greedy agglomerative on CENTROID linkage,
// not the single-link union-find `clusters.ts` uses for phashes. Single-link
// is right for near-duplicate images (A~B~C really is one burst) and wrong for
// faces: a chain of pairwise-similar faces walks from one person to another
// through the people who look a bit like both. Candidate pairs are visited in
// ascending-distance order with ids as the tiebreak, and a merge is refused
// when the two groups' centroids are farther apart than the threshold — so the
// result depends on the data alone and a rebuild is byte-stable.

import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";
import { cosine, decodeVector } from "./similarity.js";

/** The logical entity a face embedding is keyed by (`schema/tables.ts`). */
export const FACE_REGION_TARGET_TYPE = "media.face_region";

/**
 * Cosine distance within which an unnamed proposed face may be offered to the
 * member as a named party's. Conservative — see the header. Asking "is this
 * Ana?" about a stranger costs one tap; the alternative failure, quietly
 * filing a stranger under a name, is the one that destroys trust in the shelf.
 */
export const FACE_PARTY_MAX_DISTANCE = 0.3;

/**
 * Cosine distance within which two UNNAMED faces may be grouped together.
 * Stricter than the party threshold because a stranger group is named in one
 * gesture: every false member of it is mislabelled by that single act, whereas
 * a party proposal is reviewed face by face.
 */
export const FACE_CLUSTER_MAX_DISTANCE = 0.22;

/**
 * How many faces make a group worth offering. A lone unmatched face is not a
 * person to name from a shelf — it is one face on one photograph, named from
 * that photograph's own review. Grouping it alone would fill the People shelf
 * with strangers seen once, which is the shelf's own version of the fake
 * "Categories" grid the mobile Collections page deleted.
 */
export const FACE_MIN_CLUSTER_SIZE = 2;

export interface FaceClusterResult {
  /** Proposed regions this pass wrote a candidate party onto. */
  matched: number;
  /** Distinct unnamed groups of `FACE_MIN_CLUSTER_SIZE`+ regions. */
  clusters: number;
  /** Regions that landed in some group (excludes ungrouped singletons). */
  clustered: number;
  /** `media_face_cluster` rows actually inserted, updated or deleted. */
  updated: number;
}

interface RegionRow {
  region_id: string;
  party_id: string | null;
  confirmed_by_party_id: string | null;
  review_state: string;
  model: string;
  vector: Uint8Array;
}

interface Candidate {
  regionId: string;
  unit: Float32Array;
}

/**
 * L2-normalise once so every later comparison is a dot product and a centroid
 * is a plain mean. A zero vector cannot be normalised and cannot be compared;
 * it is dropped rather than given an arbitrary direction.
 */
function unitOf(blob: Uint8Array): Float32Array | null {
  const values = decodeVector(Buffer.from(blob));
  let norm = 0;
  for (const value of values) norm += value * value;
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const scale = 1 / Math.sqrt(norm);
  const unit = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) unit[i] = values[i]! * scale;
  return unit;
}

/** Mean of unit vectors, itself re-normalised. `null` for an empty set. */
function centroidOf(members: readonly Float32Array[]): Float32Array | null {
  const first = members[0];
  if (!first) return null;
  const comparable = members.filter((member) => member.length === first.length);
  const sum = Array.from({ length: first.length }, (_unused, i) =>
    comparable.reduce((total, member) => total + (member[i] ?? 0), 0)
  );
  const norm = sum.reduce((total, value) => total + value * value, 0);
  if (!(norm > 0)) return null;
  const scale = 1 / Math.sqrt(norm);
  return Float32Array.from(sum, (value) => value * scale);
}

/** 1 - cosine similarity. Incomparable widths are "as far apart as possible". */
function distance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 2;
  return 1 - cosine(a, b);
}

interface Group {
  /** Member region ids, kept sorted so the lowest is the group's identity. */
  members: string[];
  centroid: Float32Array;
}

/**
 * Greedy centroid-linkage agglomerative clustering over unit vectors. Pairs
 * are considered in ascending distance, ties broken by region id, so the
 * output is a pure function of the input — no `Math.random`, no wall clock,
 * no map-iteration order leaking into the answer.
 */
function agglomerate(
  candidates: readonly Candidate[],
  threshold: number
): Group[] {
  const groups = new Map<string, Group>();
  for (const candidate of candidates) {
    groups.set(candidate.regionId, {
      members: [candidate.regionId],
      centroid: candidate.unit,
    });
  }
  // Every pair once, cheapest first. A personal library's face count is in the
  // thousands, so the quadratic pass is milliseconds and buys an exact answer;
  // the phash sidecar's band index exists because ITS input is the whole
  // library of photographs, which is an order of magnitude larger.
  const pairs: { a: string; b: string; d: number }[] = [];
  for (let i = 0; i < candidates.length; i += 1)
    for (let j = i + 1; j < candidates.length; j += 1) {
      const d = distance(candidates[i]!.unit, candidates[j]!.unit);
      if (d <= threshold)
        pairs.push({
          a: candidates[i]!.regionId,
          b: candidates[j]!.regionId,
          d,
        });
    }
  pairs.sort((x, y) => {
    if (x.d !== y.d) return x.d - y.d;
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    return x.b < y.b ? -1 : 1;
  });

  // Every region maps to its group's key; a merge rewrites the absorbed
  // group's members rather than leaving a chain to follow, so lookup is one
  // hop and the map is always the whole truth.
  const rootOf = new Map<string, string>();
  for (const candidate of candidates)
    rootOf.set(candidate.regionId, candidate.regionId);
  const unitById = new Map(candidates.map((c) => [c.regionId, c.unit]));

  for (const pair of pairs) {
    const ra = rootOf.get(pair.a) as string;
    const rb = rootOf.get(pair.b) as string;
    if (ra === rb) continue;
    const ga = groups.get(ra);
    const gb = groups.get(rb);
    if (!ga || !gb) continue;
    // THE NO-CHAINING RULE (see the header): two groups merge only when their
    // centroids are themselves within the threshold, so similarity cannot walk
    // from one person to another through a face that resembles both.
    if (distance(ga.centroid, gb.centroid) > threshold) continue;
    const members = [...ga.members, ...gb.members].sort();
    const centroid = centroidOf(
      members
        .map((id) => unitById.get(id))
        .filter((u): u is Float32Array => u !== undefined)
    );
    if (!centroid) continue;
    // The lowest region id is the group's identity, here and in the projection
    // — the same rule `clusters.ts` and `memories.ts` use, so an unchanged
    // group never renames itself between passes.
    const survivor = members[0] as string;
    groups.delete(ra);
    groups.delete(rb);
    groups.set(survivor, { members, centroid });
    for (const member of members) rootOf.set(member, survivor);
  }
  return [...groups.values()].filter(
    (group) => group.members.length >= FACE_MIN_CLUSTER_SIZE
  );
}

/**
 * Recompute face grouping over LIVE (non-trashed) photographs: match unnamed
 * proposals to already-confirmed parties, then group whatever is left with
 * itself into `media_face_cluster`.
 *
 * Safe to call on any cadence and from a cold start — it holds nothing between
 * calls and reads every fact it uses from the vault. Idempotent: a second run
 * over unchanged data writes nothing (compare-then-write, the same rule
 * `clusters.ts` follows, so a steady-state sweep dirties no WAL pages and
 * wakes no replica).
 */
export function rebuildFaceClusters(
  vault: DatabaseSync,
  options: { now?: string } = {}
): FaceClusterResult {
  const now = options.now ?? nowIso();
  const rows = vault
    .prepare(
      `SELECT r.region_id     AS region_id,
              r.party_id      AS party_id,
              r.confirmed_by_party_id AS confirmed_by_party_id,
              r.review_state  AS review_state,
              e.model         AS model,
              e.vector        AS vector
         FROM media_face_region r
         JOIN media_media_asset a ON a.asset_id = r.asset_id
         JOIN enrich_embedding e
           ON e.target_type = ? AND e.target_id = r.region_id
        WHERE a.deleted_at IS NULL
          AND r.review_state IN ('proposed','confirmed')
        ORDER BY e.model, r.region_id`
    )
    .all(FACE_REGION_TARGET_TYPE) as unknown as RegionRow[];

  const result: FaceClusterResult = {
    matched: 0,
    clusters: 0,
    clustered: 0,
    updated: 0,
  };

  const byModel = new Map<string, RegionRow[]>();
  for (const row of rows) {
    const group = byModel.get(row.model);
    if (group) group.push(row);
    else byModel.set(row.model, [row]);
  }

  const assign = vault.prepare(
    // `review_state` is deliberately NOT touched: this writes the enricher's
    // candidate, and a candidate is a question. Only the owner's own verb
    // (`media.answer_face_proposal`) moves a region out of 'proposed'.
    "UPDATE media_face_region SET party_id = ? WHERE region_id = ? AND review_state = 'proposed'"
  );
  const clusterOf = new Map<string, string>();

  for (const model of [...byModel.keys()].sort()) {
    const group = byModel.get(model) as RegionRow[];

    // (a) Centroids from the owner's own confirmations. `party_id` is WHO the
    // face is; `confirmed_by_party_id` is who said so — a different axis, and
    // grouping on it would fold "confirmed by Sam" into a person called Sam.
    const confirmedByParty = new Map<string, Float32Array[]>();
    for (const row of group) {
      if (row.review_state !== "confirmed" || !row.party_id) continue;
      const unit = unitOf(row.vector);
      if (!unit) continue;
      const members = confirmedByParty.get(row.party_id);
      if (members) members.push(unit);
      else confirmedByParty.set(row.party_id, [unit]);
    }
    const centroids: { partyId: string; centroid: Float32Array }[] = [];
    for (const partyId of [...confirmedByParty.keys()].sort()) {
      const centroid = centroidOf(
        confirmedByParty.get(partyId) as Float32Array[]
      );
      if (centroid) centroids.push({ partyId, centroid });
    }

    // (b) Unassigned proposals → the party they are near, when exactly one
    // party is near at all. Two candidates is not a close call to break with a
    // tiebreak; it is the case where the enricher does not know, and saying so
    // by leaving the region unnamed is the honest answer.
    const leftovers: Candidate[] = [];
    for (const row of group) {
      if (row.review_state !== "proposed") continue;
      const unit = unitOf(row.vector);
      if (!unit) continue;
      if (row.party_id) continue; // already carries a candidate — not ours to move
      const near = centroids.filter(
        (entry) => distance(unit, entry.centroid) <= FACE_PARTY_MAX_DISTANCE
      );
      if (near.length === 1) {
        const changed = assign.run(near[0]!.partyId, row.region_id).changes;
        if (Number(changed) > 0) result.matched += 1;
        continue;
      }
      leftovers.push({ regionId: row.region_id, unit });
    }

    // (c) Everything still unnamed groups with itself.
    for (const cluster of agglomerate(leftovers, FACE_CLUSTER_MAX_DISTANCE)) {
      const clusterId = cluster.members[0] as string;
      result.clusters += 1;
      for (const member of cluster.members) clusterOf.set(member, clusterId);
    }
  }
  result.clustered = clusterOf.size;

  // Compare-then-write. The projection is conceptually recomputed wholesale —
  // nothing here reads its own previous output — but only the rows whose
  // membership actually moved are written, so an unchanged library costs one
  // read and zero WAL pages, and an offline phone is not woken to be told
  // nothing changed.
  const existing = new Map(
    (
      vault
        .prepare("SELECT region_id, cluster_id FROM media_face_cluster")
        .all() as unknown as { region_id: string; cluster_id: string }[]
    ).map((row) => [row.region_id, row.cluster_id])
  );
  const upsert = vault.prepare(
    `INSERT INTO media_face_cluster (region_id, cluster_id, computed_at)
     VALUES (?, ?, ?)
     ON CONFLICT (region_id) DO UPDATE SET
       cluster_id = excluded.cluster_id, computed_at = excluded.computed_at`
  );
  const drop = vault.prepare(
    "DELETE FROM media_face_cluster WHERE region_id = ?"
  );
  for (const [regionId, clusterId] of [...clusterOf].sort(([a], [b]) =>
    a < b ? -1 : 1
  )) {
    if (existing.get(regionId) === clusterId) continue;
    upsert.run(regionId, clusterId, now);
    result.updated += 1;
  }
  for (const regionId of [...existing.keys()].sort()) {
    if (clusterOf.has(regionId)) continue;
    drop.run(regionId);
    result.updated += 1;
  }
  return result;
}
